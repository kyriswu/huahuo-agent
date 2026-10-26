# 第三阶段 D1：真实 Embedding 与持久化状态

## SiliconFlow Embedding

正式候选配置为 SiliconFlow OpenAI-compatible Embeddings API：

- Base URL：`https://api.siliconflow.cn/v1`
- Model：`BAAI/bge-m3`
- 预期维度：`1024`
- 请求体包含 `model`、`input` 和 `encoding_format: "float"`
- BGE-M3 请求不发送 `dimensions`

`OpenAICompatibleEmbeddingClient` 使用原生 `fetch`，支持批量输入、超时、有限重试、响应索引完整性检查、有限数字和维度校验，并将认证、限流、服务端、非法请求、网络和超时错误分类。真实检查命令为：

```bash
npm run rag:embedding:check
```

缺少本地配置时退出码为 `2`；不会自动切换到 Mock。

## PostgreSQL 状态存储

`migrations/0003_rag_state.sql` 创建以下表：

- `rag_document_heads`：每个文档的当前有效版本指针和 generation。
- `rag_document_versions`：内容版本、Pipeline、模型、维度、状态和错误信息。
- `rag_ingestion_jobs`：唯一幂等键、任务状态、尝试次数、租约和 fencing token。
- `rag_index_chunks`：可选的索引清单，用于恢复和对账。

`PostgresDocumentVersionStore` 保留 `DocumentVersionStore` 与任务仓储接口。文档版本切换使用 PostgreSQL 事务：锁定候选版本、确认 `ready`、旧版本转为 `superseded`、新版本转为 `visible`，最后更新 head。未完成版本不能激活；旧版本在新版本失败时继续有效。

Milvus 与 PostgreSQL 不声明跨库原子事务。Milvus 使用稳定 Chunk ID 执行 upsert，入库服务在写入计数核验后才更新 PostgreSQL 状态。恢复和对账不执行全量删除；缺少原文恢复协调器时只发现任务并返回 `BLOCKED`。

## 显式命令与安全边界

迁移只对授权测试数据库执行：

```bash
RAG_STATE_MIGRATION_ALLOW=true npm run rag:state:migrate
```

正式 Collection 初始化要求 `RAG_MILVUS_INIT_ALLOW=true`、授权测试目标、授权 Milvus 地址、`huahuo_chunks` 和 BGE-M3/1024 维配置。验收脚本不会在 Collection 不存在时隐式创建它。

独立进程 PostgreSQL 状态检查：

```bash
npm run rag:state:process-check -- --scenario=all
```

该检查要求 `RAG_STATE_PROCESS_CHECK_ALLOW=true`，会使用唯一测试文档 ID 验证两个独立 Node.js 进程之间的状态读取、数据库唯一幂等键、并发租约以及未验证版本保护。它只证明 PostgreSQL 状态层，不替代 Milvus 跨库恢复验收。

## 当前真实验收边界

没有本机轮换后的 Embedding API Key、授权 PostgreSQL URL 和授权 Milvus 配置时，真实 Embedding、迁移、正式 Collection、Dense 入库/检索和跨存储重启验收均保持 `BLOCKED`。Mock 验收只证明应用编排、稳定 ID、幂等和故障状态转移，不能作为真实 Dense RAG 通过证据。
