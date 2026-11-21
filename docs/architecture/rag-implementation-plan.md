# RAG 检索与独立入库工具

HuoX 的检索工具通过 `RagClient` 请求 Server 的 `POST /internal/v1/rag/query`。
工具校验查询参数，传递可信用户身份和取消信号。Server 核对权限、选择当前索引，
并返回排好序的文本片段、来源和检索元数据。

## 独立入库能力

- `chunk-markdown.ts` 提供稳定的 Markdown 规范化、切片、标题路径和内容哈希。
- `embedding-client.ts` 提供 OpenAI-compatible Embedding 客户端，包含超时、有限重试、响应和维度校验。
- `PostgresDocumentVersionStore` 提供版本、可见 head、幂等任务、租约和 fencing 状态。
- `PostgresRagChunkStore` 保存规范化 chunk 正文和引用元数据，不保存向量。
- `RagChunkRepositoryPort` 是入库用例的索引写入接口，由内存测试适配器实现。
- 本地测试和 mock 验收不连接数据库、Embedding 服务或向量服务。

## 设计约束

1. `huahuo-server` 是用户、租户、知识库和原始文件的权威来源。
2. Agent 只保存可重建的索引状态、规范化 chunk 正文和运行时数据。
3. `documentId + documentVersion + contentHash + pipelineVersion + embeddingProfile` 构成幂等身份。
4. 新版本完成并通过索引校验后才能切换为 `visible`。入库失败时旧版本继续可用。
5. 独立工具的真实外部写入由操作者显式配置和执行，目标为授权测试环境。

## 当前验证命令

```bash
pnpm run typecheck
pnpm run build
pnpm run rag:test
pnpm run rag:ingest:mock
pnpm run rag:acceptance:dense:mock
```

独立工具的测试库迁移和跨进程检查见 [RAG 验收说明](../../README.md#deterministic-acceptance)。
