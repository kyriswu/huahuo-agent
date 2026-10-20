# RAG 架构与混合检索

## 结论

本阶段目标后端为 Milvus，统一使用 `huahuo_chunks` Collection。检索采用 Milvus 原生 BM25 Sparse + Dense Vector Hybrid Search，并先使用 RRF 融合候选，再调用独立 Rerank Adapter 做最终排序。

第一阶段提出的 PostgreSQL + pgvector 保留为对比方案，但暂不实现双后端，也不把 RAG 核心逻辑绑定到 MastraVector 子类。

## 组件关系

```text
src/mastra/tools/knowledge-search-tool.ts
                |
                v
src/application/rag/search-knowledge.ts
       |                |                 |
       v                v                 v
 MilvusAdapter   RerankAdapter   SourceContentAdapter
       |                |                 |
       v                v                 v
 dense + BM25     外部 Rerank API   huahuo-server API/派生缓存
```

入库链路使用同样的分层：

```text
IndexDocumentUseCase
  -> SourceContentAdapter
  -> MarkdownPreprocessor/Chunker
  -> EmbeddingAdapter
  -> MilvusAdapter
  -> IndexVersionStore / 状态回调
```

Mastra Tool 不能直接组装 Milvus filter、调用 Embedding 或执行 Rerank。它只负责 Zod 参数校验、请求上下文传递、结构化输出和错误映射。

## 入库流程

```text
业务事件或索引请求
  -> 获取稳定 source/document/version 和授权信息
  -> 读取正文或文件解析文本
  -> Markdown 标题感知预处理
  -> 段落边界切片 + overlap + token 上限
  -> 为每个 chunk 生成 chunkId 和 contentHash
  -> Embedding 批量请求
  -> 写入新 documentVersion 的 Milvus 行
  -> 校验行数、向量维度和版本状态
  -> 标记 ready
  -> 原子切换可见版本
```

新版本构建失败时，旧版本仍然是可见版本。删除旧版本必须是异步清理动作，不能和新版本构建绑定在同一条不可恢复的链路中。

Embedding 模型、版本和维度必须写入索引版本元数据。更换模型时创建新的 `embeddingProfile` 和新版本索引；不得假设旧向量与新查询向量兼容。

## 查询流程

```text
用户问题
  -> 权限服务确定 allowedKnowledgeBaseIds
  -> Query Embedding
  -> Dense ANN Search
  -> BM25 Full-text Search
  -> Milvus Hybrid Search + RRFReranker
  -> 可见版本过滤和 chunk 过滤
  -> 外部 Rerank
  -> score 阈值、数量和来源过滤
  -> 按 documentId 聚合
  -> 按需加载完整文章
  -> 返回结构化检索结果
```

Dense 与 BM25 的召回数量分别配置，例如各自 `candidateK=20`，Milvus Hybrid Search 输出 20 个候选，外部 Rerank 保留 5 个 chunk。实际数值需通过离线样例调优，不能写成业务协议的一部分。

Milvus 官方提供 `hybridSearch`、BM25 Function 和 `RRFReranker`。RRF 先按照排名融合不同检索路径，避免直接比较 Dense 相似度和 BM25 分数的量纲。外部 Rerank 是第二阶段精排，不等同于 Milvus 内部的 RRF。

## BM25 与语言分析器

Milvus 默认 `standard` analyzer 适合用空格和标点分词的语言，但不会把连续中文文本切成中文词。中文、英文和混合文本需要在目标 Milvus 版本中验证：

- 中文：优先验证 `chinese` analyzer（Jieba + `cnalphanumonly`）。
- 中英混合：验证 multi-language analyzer，根据 `language` 字段选择 `chinese`、`english` 或默认 ICU/standard analyzer。
- 若需要拼音查询，再验证 Jieba + `pinyin` filter；不能默认开启，因为会改变索引体积和召回行为。
- 对标题、代码标识符、URL 和产品名，可考虑保留原始文本字段或独立 BM25 字段，避免过滤器损失精确词。

创建 Collection 前必须用 Milvus `runAnalyzer` 对代表性的中文、英文、中英混合、数字、版本号和产品名样本验收。Analyzer 配置属于 Collection schema 版本，变更后应重建对应 BM25 索引版本。

## 多知识库检索

RAG 服务接收业务服务确定的授权范围，而不是信任客户端字段。服务内部将范围编译为不可变的 Milvus filter：

```text
tenant_id == trustedTenantId
&& document_version_state == "ready"
&& document_version in visibleVersions
&& knowledge_base_id in allowedKnowledgeBaseIds
```

一个请求检索多个知识库时，使用同一 Collection 的 `in [...]` 过滤。若共享内容的物理 chunk 只存一份，则不能把 `knowledge_base_id` 作为唯一归属字段；应使用独立的授权关联表/缓存，将可检索知识库集合编译为 `knowledge_base_ids` 数组或授权边映射。具体字段形态以 Milvus 版本和过滤性能验证为准。

Collection 层统一保存内容与索引版本；知识库成员关系由业务服务保存，Agent 侧只保存短期授权投影或可重建的关联数据。这样同一原始资产加入多个知识库时不复制向量。

## Partition Key 策略

第一阶段不直接把 `knowledge_base_id` 设为 Partition Key。原因是知识库数量、多库联合检索和跨知识库共享都可能导致高基数字段，且每个请求必须包含 Partition Key 才能获得预期路由效果。

候选策略：

1. 初始使用普通标量字段和 filter，先验证召回正确性、过滤延迟和并发隔离。
2. 如果租户数量巨大且绝大多数请求只访问单一租户，可评估 `tenant_id` 作为 Partition Key。
3. 如果启用 Partition Key Isolation，查询必须带单一明确的租户值；多租户联合查询和复杂共享场景不能依赖它提供隔离。
4. Partition Key 是性能路由，不是授权机制。授权仍由服务端可信上下文决定。

Milvus 官方说明 Partition Key 可以缩小搜索范围，但 Partition Key 级别的物理隔离较弱，且不提供 RBAC。需要强隔离时应使用更高层级的数据库/Collection 策略，或在服务层拆分资源。

## 全文加载策略

切片检索和全文加载是两个独立操作：

- `searchChunks` 只返回切片和排序信息。
- `loadDocuments` 接收去重后的 `documentId + documentVersion` 列表，按需向业务服务取全文。
- Agent 默认只把 `matchedChunks` 和标题/来源元数据放入上下文。
- 只有当 Tool 参数或后续步骤明确要求完整文章时才加载正文。
- 全文结果必须再次校验 `documentVersion` 和当前授权状态。

原文已删除或授权撤销时，业务服务返回不可访问，RAG 服务必须过滤掉旧索引，即使 Milvus 中仍存在旧行。

## 错误和可观测性

外部调用统一设置超时、有限重试和 AbortSignal。错误分为：

- `EmbeddingProviderUnavailable`
- `RerankProviderUnavailable`
- `MilvusUnavailable`
- `IndexVersionNotReady`
- `SourceNotAuthorized`
- `SourceContentUnavailable`

日志记录 requestId、traceId、阶段、耗时、候选数量、版本和错误类型；不记录 API Key、数据库连接串、全文正文或未经脱敏的用户输入。

## 依据与当前验证结论

- [Milvus BM25 Function](https://milvus.io/docs/bm25-function.md)：BM25 在 Milvus 内部由文本生成 Sparse 表示，不需要外部 BM25 模型。
- [Milvus Multi-Vector Hybrid Search](https://milvus.io/docs/multi-vector-search.md)：支持多向量字段和 Hybrid Search。
- [Milvus Reranking](https://milvus.io/docs/reranking.md)：支持 `RRFRanker` 与 `WeightedRanker`。
- [Milvus Chinese Analyzer](https://milvus.io/docs/chinese-analyzer.md)：中文 analyzer 基于 Jieba，兼容性需按服务版本验证。
- [Milvus Multi-language Analyzers](https://milvus.io/docs/multi-language-analyzers.md)：支持按字段选择 analyzer，兼容 Milvus 2.5.11+ 文档范围。
- [Milvus Node.js SDK](https://milvus.io/docs/install-node.md)：Milvus 3.0.x 推荐最新 SDK，2.6.x 应使用对应 2.6.x SDK。
- [Milvus Node SDK Hybrid Search](https://github.com/milvus-io/milvus-sdk-node)：当前官方 Node SDK 文档包含 `hybridSearch`、BM25 相关字段和过滤接口。
