# RAG 实施计划

本项目保留 Mastra 天气示例作为 smoke test，RAG 代码保持在独立的
Application 和 Adapter 边界内。当前只实现与后端无关的切片、Embedding、状态和正文存储
能力；向量检索后端在确认需求后再通过 `RagChunkRepositoryPort` 接入。

## 当前状态

- `chunk-markdown.ts` 提供稳定的 Markdown 规范化、切片、标题路径和内容哈希。
- `embedding-client.ts` 提供 OpenAI-compatible Embedding 客户端，包含超时、有限重试、响应和维度校验。
- `PostgresDocumentVersionStore` 提供版本、可见 head、幂等任务、租约和 fencing 状态。
- `PostgresRagChunkStore` 保存规范化 chunk 正文和引用元数据，不保存向量。
- `RagChunkRepositoryPort` 是后续向量索引的唯一应用边界；当前只由内存测试适配器实现。
- 本地测试和 mock 验收不连接数据库、Embedding 服务或向量服务。

## 设计约束

1. `huahuo-server` 是用户、租户、知识库和原始文件的权威来源。
2. Agent 只保存可重建的索引状态、规范化 chunk 正文和运行时数据。
3. `documentId + documentVersion + contentHash + pipelineVersion + embeddingProfile` 构成幂等身份。
4. 新版本完成并通过索引校验后才能切换为 `visible`；旧版本在失败时继续可用。
5. Tool 不直接调用 Embedding、向量后端或 Rerank 服务。
6. 所有真实外部写入必须显式配置、显式执行，并指向授权测试环境。

## 后续接入顺序

### 1. 确定向量后端

比较候选后端的过滤、混合检索、租户隔离、索引生命周期、备份和运维成本。选定后只增加
一个实现，不在第一版同时维护多个向量数据库。

### 2. 实现向量适配器

适配器实现 `RagChunkRepositoryPort` 和检索 Provider，负责连接管理、批量 upsert、向量
维度校验、可见版本过滤、超时、重试和错误映射。应用层不应出现后端专有类型或查询语法。

### 3. 补充真实验收

真实验收必须覆盖：重复入库、版本切换、部分批次失败、恢复、租户过滤、撤权、索引维度和
跨进程状态。普通单元测试继续使用内存适配器，不连接生产服务。

### 4. 接入 Mastra Tool

Tool 只做 Zod 参数校验、可信授权上下文传递、调用 `searchKnowledge` 和结构化来源返回。
天气 Agent 的既有行为保持不变。

## 当前验证命令

```bash
pnpm run typecheck
pnpm run build
pnpm run rag:test
pnpm run rag:ingest:mock
pnpm run rag:acceptance:dense:mock
```

## 当前明确不做

- 不在应用中直接绑定具体向量数据库 SDK。
- 不在没有真实后端选择前提供生产入库或真实检索命令。
- 不复制业务服务的用户、文件、笔记或知识库主数据。
- 不自动执行生产迁移、创建索引或清理外部数据。
