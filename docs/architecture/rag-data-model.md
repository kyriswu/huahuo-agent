# RAG 数据模型、版本和多租户

## 设计原则

1. `huahuo-server` 是原始文章、文件和知识库归属的权威来源。
2. Milvus 只保存派生切片、Embedding、BM25 Function 输出和来源/版本关联。
3. 稳定身份、版本和幂等状态不能由 `contentHash` 单独决定。
4. 新版本索引完成后再切换可见版本。
5. 同一物理内容可以被多个知识库授权引用，但只生成一份向量。
6. 所有查询必须经过服务端授权范围和可见版本过滤。

## 稳定身份

### 来源抽象

跨服务 DTO 使用以下概念：

```ts
type SourceRef = {
  sourceId: string;          // 业务资产稳定 ID，例如 noteId/assetId
  sourceType: 'article' | 'file' | 'note';
  documentId: string;       // Agent 侧稳定文档 ID，跨版本不变
  documentVersion: string;  // 业务侧版本号或不可变版本 ID
  contentHash: string;      // 规范化正文/解析文本的 SHA-256
};
```

`documentId` 是当前文档的稳定身份，不能随着正文变化而改变。`documentVersion` 表示一次可索引的内容版本。`contentHash` 用于检测同一版本重复请求和发现业务端漏发版本号，不作为完整主键。

建议 Agent 侧维护一份很小的索引状态存储，而不是复制完整业务表：

```text
rag_documents
  document_id
  source_id
  source_type
  current_requested_version
  visible_version
  current_content_hash
  status
  updated_at
```

如果不希望在 Agent 引入关系数据库，可以将这些状态放在 huahuo-server 的索引状态 API 或事件投影中；Milvus 行本身不能承担完整的状态机职责。

## Milvus Collection：`huahuo_chunks`

以下字段是逻辑模型，实际类型和长度要根据目标 Milvus 服务版本确认：

| 字段 | 类型建议 | 作用 |
|---|---|---|
| `chunk_id` | VarChar 主键 | 切片稳定 ID，建议由 `documentId:documentVersion:chunkIndex:chunkHash` 派生或由业务生成 |
| `tenant_id` | VarChar | 租户过滤和候选 Partition Key；值由可信服务端填充 |
| `owner_id` | VarChar | 业务归属投影，不作为唯一授权依据 |
| `knowledge_base_ids` | Array/JSON 或授权投影 | 同一 chunk 可被多个知识库引用；具体字段需验证过滤支持 |
| `source_id` | VarChar | 业务文章/资产 ID |
| `source_type` | VarChar | `article`、`file`、`note` |
| `document_id` | VarChar | 稳定文档 ID |
| `document_version` | VarChar | 不可变版本标识 |
| `document_version_state` | VarChar | `building`、`ready`、`retired`、`deleted` |
| `content_hash` | VarChar | 规范化内容哈希 |
| `chunk_hash` | VarChar | 当前切片文本哈希 |
| `chunk_index` | Int32 | 文档内顺序 |
| `heading_path` | Array/JSON | Markdown 标题路径 |
| `language` | VarChar | analyzer 选择和调试 |
| `text` | VarChar | BM25 Function 的输入文本和结果展示 |
| `dense` | FloatVector | Embedding 向量 |
| `embedding_profile` | VarChar | 模型、版本和维度的稳定配置 ID |
| `created_at` | Int64/VarChar | 运行和清理追踪 |

BM25 建议使用 `text` 字段加 Milvus BM25 Function 生成 Sparse 输出字段，例如 `text_sparse`。Dense 字段和 Sparse 字段分别建立相应索引，再通过 Hybrid Search + RRF 合并。

`embedding_profile` 是必要字段。更换 Embedding 模型、维度或预处理方式时创建新的索引版本/profile，不能直接覆盖旧向量。

## 多知识库和共享内容

### 物理去重

同一 `documentId + documentVersion + contentHash + embeddingProfile + chunkerProfile` 只生成一份物理 chunk。`chunk_id` 不应包含单个知识库 ID，否则内容加入多个知识库时会产生重复向量。

### 逻辑授权

知识库、分享、订阅和成员关系由 `huahuo-server` 管理。Agent 通过授权 API 或事件投影获得：

```ts
type RetrievalScope = {
  tenantId: string;
  allowedKnowledgeBaseIds: string[];
  allowedDocumentIds?: string[];
  asOf: string;
};
```

Agent 根据这个范围构造 Milvus filter。客户端传入的知识库列表只能作为意图，不能直接作为允许范围。

有两种实现路径，应先在 PoC 中验证：

1. `knowledge_base_ids` 作为 Milvus Array/JSON 字段，使用 `array_contains` 或对应过滤表达式。
2. 单独的授权投影表/缓存保存 `chunk_id -> authorized knowledge bases`，查询先得到允许的 document/chunk ID 集合，再将范围作为 filter。

路径 1 更适合查询规模可控的场景，路径 2 更容易表达复杂分享和撤权，但可能需要额外查询。两者都不复制原文和向量。

## 版本状态机

```text
requested
  -> fetching
  -> chunking
  -> embedding
  -> writing
  -> ready
  -> visible
  -> retired
  -> deleted
```

失败状态可从 `fetching`、`chunking`、`embedding` 或 `writing` 转为 `failed`，并保留错误码和重试次数。`visible` 版本只能在新版本达到 `ready` 且行数/维度校验通过后切换。

查询只允许 `visible` 版本；正在构建的版本不参与检索。旧 `visible` 版本在新版本失败时继续可用。

### 幂等规则

同一个 `documentId + documentVersion + contentHash + pipelineProfile` 的重复请求返回已有索引状态，不重新写向量。

正文修改必须带新 `documentVersion`。如果版本号不变但 `contentHash` 变化，应拒绝或转为显式重建请求，不能静默覆盖已可见版本。

删除或撤权事件必须将对应版本标记为 `retired/deleted`，同时让业务服务在全文读取和授权查询中阻断访问。Milvus 删除是异步最终一致操作，不能用“删除请求已发送”作为授权成功的依据。

## Milvus 和状态存储的一致性

Milvus 与任何状态数据库之间不存在假定的跨库事务。推荐使用可恢复状态机：

1. 先写入 `requested/building` 状态和 idempotency key。
2. Milvus 使用新 `documentVersion` 写入 chunk。
3. 查询/计数确认写入完整且向量维度正确。
4. 写入 `ready`，再更新 `visible_version`。
5. 失败时保留 `failed` 状态和错误信息，重试同一 idempotency key。
6. 旧版本只有在新版本可见后才进入清理队列。

如果进程在步骤 2-4 崩溃，恢复任务根据 idempotency key 查询 Milvus 并继续或清理未完成版本。

## 原文映射

Milvus 不承担业务原文主存储。检索结果至少携带：

```ts
type RetrievedChunk = {
  documentId: string;
  chunkId: string;
  chunkText: string;
  matchedChunks: string[];
  sourceId: string;
  title?: string;
  sourceType: string;
  retrievalScore: number;
  rerankScore?: number;
  documentVersion: string;
};
```

需要完整文章时，使用 `documentId + documentVersion` 调用 `huahuo-server`。Agent 可缓存全文，但缓存必须包含版本和授权失效信息，且可以被业务事件清除。

## 字段与过滤风险

- Array/JSON 字段的过滤操作符要以实际 Milvus Server/SDK 版本为准。
- `in` 列表过大时，不能把所有知识库 ID 拼成无限长表达式，应限制数量或改用授权投影。
- 过滤条件必须由 Adapter 参数化生成，禁止把客户端字符串直接拼接进表达式。
- `tenant_id`、`document_version_state` 和 `document_version` 是每次搜索都需要验证的字段。
- Partition Key 只能用于缩小搜索范围，不能替代权限校验。

## 参考资料

- [Milvus multi-tenancy](https://milvus.io/docs/multi_tenancy.md)
- [Milvus partition key](https://milvus.io/docs/use-partition-key.md)
- [Milvus BM25 Function](https://milvus.io/docs/bm25-function.md)
- [Milvus multi-language analyzers](https://milvus.io/docs/multi-language-analyzers.md)
