# RAG 分阶段实施计划

本计划遵循最小改动原则，保留当前已初始化的 Mastra 项目，不重新执行 `npm create mastra@latest`，不重构现有天气示例。

## 现状和前置约束

- 当前直接依赖为 `@mastra/core@1.78.0`、`mastra@1.34.2`、`zod@3.25.76`。
- 当前仅有天气 Agent、Tool、Workflow，`src/application` 和 `src/adapters` 为空边界占位。
- 当前没有 PostgreSQL、Redis、Milvus、Embedding 或 Rerank 客户端。
- 当前没有项目级测试脚本；`npm run typecheck` 已通过。
- 本阶段不安装依赖、不连接数据库、不执行生产迁移。

## 阶段 0：服务和版本核验

### 目标

确认目标 Milvus Server 版本、部署模式、认证方式、TLS、Collection API 和 Node SDK 兼容版本。

### 需要提供或核验的配置

```env
MILVUS_ADDRESS=
MILVUS_TOKEN=
MILVUS_DATABASE=
MILVUS_TLS=
```

还需要确认目标环境是 Milvus 2.5.x、2.6.x 还是 3.0.x。官方 Node SDK 安装文档建议 2.6.x 使用对应 2.6.x SDK，3.0.x 使用最新 SDK；当前 npm 页面显示 `@zilliz/milvus2-sdk-node` 的 3.0.x 系列。未确认服务版本前不锁定具体 SDK 小版本。

### 验收

- 能通过 health/describe API 读取 Server 版本。
- 用目标 SDK 创建测试 Collection、运行 analyzer、写入一条 Dense+BM25 数据并执行 Hybrid Search。
- 验证 `filter`、`in`、Array/JSON 字段和 `RRFReranker` 的实际行为。

## 阶段 1：依赖和配置骨架

### 建议依赖

根据阶段 0 的服务版本选择并固定：

- `@zilliz/milvus2-sdk-node`：与 Milvus Server 主/次版本匹配。
- 一个 HTTP 客户端：优先使用 Node 26 原生 `fetch`，暂不额外引入 Axios。
- 测试框架：建议直接依赖 `vitest`，版本与 Node 26 和项目 TypeScript 版本兼容。
- 不增加 `pg`、Elasticsearch 或 Redis，除非后续状态/授权投影确实需要。

### 文件

- 修改 `.env.example`，增加 Milvus、Embedding、Rerank、RAG 参数，不写真实凭证。
- 新增 `src/extensions/huahuo/rag/config.ts`，使用 Zod 校验环境变量。
- 新增 `src/extensions/huahuo/rag/errors.ts`。
- 新增 `src/contracts/rag.ts`，定义 `SourceRef`、`RetrievalScope`、检索结果和索引状态 DTO。

### 验收

- 配置缺失时只报告变量名和原因。
- `npm run typecheck` 通过。
- 日志和错误对象不包含凭证。

## 阶段 2：纯函数切片和外部 Adapter

### 文件

- `src/application/rag/chunk-markdown.ts`
- `src/adapters/rag/embedding-adapter.ts`
- `src/adapters/rag/rerank-adapter.ts`
- `src/adapters/rag/source-content-adapter.ts`
- `src/adapters/rag/milvus-adapter.ts`

### 设计

- 切片器负责 Markdown 标题路径、段落边界、overlap 和 token 上限。
- Embedding Adapter 负责批量请求、超时、有限重试、维度校验。
- Rerank Adapter 负责候选上限、超时、响应索引和分数校验。
- Milvus Adapter 负责 Collection 管理、写入、删除、Hybrid Search、filter 生成和结果映射。
- RAG Application Service 只依赖这些接口，测试不需要真实外部服务。

### 验收

- 中文、英文、中英混合 Markdown 产生稳定、有序的 chunk。
- Mock Embedding/Rerank/Milvus 可以覆盖成功、超时、非 2xx、格式错误和维度错误。
- 过滤表达式只能由可信 `RetrievalScope` 生成。

## 阶段 3：索引版本和幂等入库

### 文件

- `src/application/rag/index-document.ts`
- `src/application/rag/index-version.ts`
- `src/adapters/rag/index-state-adapter.ts`
- `migrations/` 或 `docs/` 中记录状态存储方案；不自动执行迁移

### 设计

- 稳定 `documentId` 跨正文版本保持不变。
- `documentVersion` 是一次不可变索引输入。
- idempotency key 为 `documentId + documentVersion + contentHash + pipelineProfile`。
- 新版本写入 Milvus 后才标记 `ready`，再切换 `visible`。
- 老版本在新版本可用后异步清理。
- 同一原始资产被多个知识库引用时只写一份物理 chunk，授权关系通过业务投影或可验证的关联字段表达。

### 验收

- 同一请求重复执行不产生重复向量。
- 内容变化会产生新版本，旧版本在新版本失败时仍可检索。
- Milvus 写入中断后可重试或清理，不会把半成品设为可见。
- 删除和撤权事件可阻断旧版本查询和全文加载。

## 阶段 4：混合检索和文章聚合

### 文件

- `src/application/rag/search-chunks.ts`
- `src/application/rag/load-documents.ts`
- `src/application/rag/search-knowledge.ts`
- `src/application/rag/aggregate-results.ts`

### 设计

- `searchChunks` 只负责 Dense/BM25 Hybrid Search、RRF、外部 Rerank 和 chunk 过滤。
- `aggregateResults` 按 `documentId + documentVersion` 去重，保留 `matchedChunks`、最高分和排序依据。
- `loadDocuments` 独立按需加载完整文章，不默认把所有全文送入模型。
- `searchKnowledge` 将两者编排为一个可测试用例。

### 验收

- 用不同措辞的自然语言问题能召回相关中文或英文文章。
- 输出包含 `documentId`、`chunkId`、`chunkText`、`sourceId`、标题、来源类型、检索分数、重排分数和版本。
- 同一文章多个切片能聚合为一条文档结果。
- 未要求全文时不调用全文加载；要求全文时按版本和授权加载。

## 阶段 5：Mastra Tool 和 Agent 接入

### 文件

- `src/mastra/tools/knowledge-search-tool.ts`
- 修改 `src/mastra/index.ts` 或现有 Agent 注册处
- 必要时新增 `src/mastra/agents/knowledge-agent.ts`，但先不改天气 Agent 的既有行为

### 设计

Tool 只做：

- Zod 参数校验。
- 传递 request context、threadId、resourceId 和可信授权范围。
- 调用 `searchKnowledge`。
- 返回结构化结果和可引用来源。

Tool 不做 Milvus 查询拼装、Embedding、Rerank、版本切换或全文权限判定。

### 验收

- Agent 能调用检索 Tool 并获得结构化来源。
- 天气 Agent、天气 Tool、天气 Workflow 仍可运行。
- `npm run typecheck` 和既有 smoke test 通过。

## 阶段 6：HTTP/SSE 和事件边界

这是后续阶段，不与第一版 RAG 核心绑定。

### 预留文件

- `src/server/http.ts`
- `src/server/sse.ts`
- `src/contracts/agent-api.ts`
- `src/adapters/huahuo-server-api.ts`

### 设计边界

- `threadId/resourceId` 交给 Mastra Memory 管理完整消息。
- huahuo-server 只保存会话归属、权限和索引。
- 上传文件通过 `assetId` 传递，不把文件复制到 Agent 业务库。
- SSE 输出模型 token、Tool 调用、RAG 阶段和错误事件。
- 服务重启后由 Mastra 状态和索引状态恢复未完成任务。

## 测试矩阵

| 场景 | 测试边界 | 必须验证 |
|---|---|---|
| Markdown 入库 | chunker + mock adapters | 切片、Embedding、Milvus upsert、状态 ready |
| 语义召回 | mock Milvus | 不同措辞仍返回相关 chunk |
| BM25 + Dense | Milvus integration test | 两条召回路径和 RRF 结果 |
| 外部 Rerank | mock HTTP | 排序、超时、响应错误 |
| 全文返回 | mock source API | 按 documentId/version 加载完整文章 |
| 重复导入 | index application test | idempotency key 不重复写入 |
| 版本切换 | state machine test | 新版本失败时旧版本仍可见 |
| 越权隔离 | retrieval scope test | 客户端伪造 ID 不扩大 filter |
| 删除/撤权 | authorization test | 旧索引和全文均不可访问 |
| 兼容回归 | existing smoke test | 天气示例和 typecheck 正常 |

真实 Milvus 集成测试应显式启用并指向测试服务，不在普通单元测试或启动命令中自动连接生产环境。

## 风险和待验证事项

1. 目标 Milvus Server 版本尚未提供，无法现在锁定 SDK 小版本。
2. Node SDK 的 BM25 Function、multi-language analyzer、Array/JSON filter 和 RRF API 需要使用目标版本执行最小 PoC。
3. 中文和中英混合 analyzer 会影响索引结果和存储大小，需要样本集评估。
4. 多知识库共享关系用 Array/JSON 字段还是授权投影，取决于过滤性能和撤权延迟。
5. Partition Key 只在单租户查询比例高、数据规模足够大时评估，不能提前作为安全设计。
6. 外部 Rerank 服务的协议、最大候选数和计费限制需要确认。
7. Embedding 模型切换需要完整新版本索引，不能在线混用不兼容维度。
8. huahuo-server 的事件幂等键、删除事件和授权查询协议需要在跨服务契约阶段确定。

## 当前明确不做

- 不添加 PostgreSQL + pgvector 实现。
- 不同时维护两个向量后端。
- 不引入 Elasticsearch 作为 BM25 默认后端。
- 不把 RAG 核心逻辑写进 Mastra Tool。
- 不复制 huahuo-server 的用户、文件、笔记或知识库业务数据。
- 不自动创建生产 Collection、执行生产迁移或连接生产服务。

## 参考资料

- [Milvus Node.js SDK 安装与版本兼容](https://milvus.io/docs/install-node.md)
- [Milvus BM25 Function](https://milvus.io/docs/bm25-function.md)
- [Milvus Multi-Vector Hybrid Search](https://milvus.io/docs/multi-vector-search.md)
- [Milvus Reranking](https://milvus.io/docs/reranking.md)
- [Milvus Analyzer Overview](https://milvus.io/docs/analyzer-overview.md)
- [Milvus Multi-tenancy](https://milvus.io/docs/multi_tenancy.md)
