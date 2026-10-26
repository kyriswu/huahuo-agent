# 第三阶段 B：RAG 基础模块实施记录

本阶段在第三阶段 A 的 Milvus Dense PoC 之上实现正式入库基础模块。PoC Collection
`huahuo_rag_poc_dense` 保留不变；正式 Collection 名称为 `huahuo_chunks`，只有在真实
Embedding 模型和维度配置齐备、并显式运行初始化脚本时才会创建。

## 切片和 Token 单位

`RAG_CHUNK_SIZE` 和 `RAG_CHUNK_OVERLAP` 使用 `heuristic-v1` 估算 Token。它不是字符数，
也不是某个具体模型的真实 tokenizer：中文字符按单个估算单位统计，英文单词和标点按词法
单位统计。切片器按标题、段落、句子边界组合文本，代码块和表格在不超过预算时保持完整；
超长块才使用词法/字符回退切分。切片结果包含标题路径、规范化文本偏移、估算数量和
SHA-256 内容哈希。

## Embedding Adapter

`OpenAICompatibleEmbeddingClient` 使用原生 `fetch` 调用：

```text
POST {RAG_EMBEDDING_BASE_URL}/embeddings
Authorization: Bearer [configured key]
{ "model": "...", "input": ["..."], "encoding_format": "float" }
```

请求重试只覆盖超时、网络错误、408、425、429 和 5xx，并有最大次数。响应必须包含与
输入数量一致的有限数字向量，且维度一致；配置了
`RAG_EMBEDDING_DIMENSIONS` 时还必须精确匹配。真实模型名称、供应商和维度不在代码中
预设，缺失时真实命令会在请求外部服务前报配置错误。

SiliconFlow 的 `BAAI/bge-m3` 使用 `https://api.siliconflow.cn/v1`，标准向量维度为
1024。SiliconFlow 文档说明 `dimensions` 请求参数仅支持 Qwen3 系列，因此该模型应设置
`RAG_EMBEDDING_SEND_DIMENSIONS=false`；配置的 1024 仍会用于响应和 Milvus Schema 校验。

## 正式 Milvus Schema

正式初始化由 `npm run rag:milvus:init` 执行，使用 `RAG_EMBEDDING_DIMENSIONS` 生成
`huahuo_chunks` Schema。字段包含 `chunk_id` 主键、可信上下文投影字段、文档身份/版本、
`document_version_state`、`content_hash`、`pipeline_version`、`heading_path`、`text`、
`run_id`、Embedding 模型/维度和 `embedding` FloatVector。`run_id` 用于验收和任务追踪，
不承担业务授权。由于锁定的
`@zilliz/milvus2-sdk-node@2.6.17` 在 Collection 创建兼容性检查中拒绝 JSON
字段，`heading_path` 和可选 `metadata` 当前以紧凑 JSON 字符串存入 VarChar；这不是
BM25 或授权模型的实现。Dense 索引为 HNSW + COSINE。初始化会核验已有 Schema 和索引，
不兼容时停止，不删除或重建 Collection。

本阶段没有创建 BM25 Function、Sparse Vector、Hybrid Search 或 Rerank。

## 版本、幂等和恢复

幂等键为：

```text
documentId + documentVersion + contentHash + pipelineVersion + embeddingModel + dimensions
```

Chunk ID 由文档身份、版本、切片序号、Chunk 哈希和切片器版本稳定计算。入库先以
`building` 状态 upsert 并按版本计数校验，再 upsert 为 `ready`；状态存储成功后才把新版本
设为 `visible`，旧版本转为 `superseded`。写入或校验失败会标记 `failed`，旧可见版本
保持不变。相同内容重复调用会复用已完成版本；同一文档版本出现不同内容哈希会拒绝。

当前保留 `InMemoryDocumentVersionStore` 用于 Mock 和单元测试，同时提供
`PostgresDocumentVersionStore` 作为真实状态实现。迁移文件
`migrations/0003_rag_state.sql` 创建文档 head、文档版本、入库任务和索引清单表；
任务使用唯一幂等键、租约和 fencing token，版本切换在 PostgreSQL 事务中完成。
真实脚本默认要求授权的 `RAG_STATE_DATABASE_URL`；只有显式设置
`RAG_INGEST_PROCESS_LOCAL_STATE=true` 才会使用进程内实现，并且这不能作为跨进程验收证据。

PostgreSQL 与 Milvus 不声称跨库原子事务：Milvus 使用稳定 Chunk ID 的 upsert，
版本进入 `ready`/`visible` 前必须完成写入计数核验。`rag:recovery:run` 和
`rag:reconcile` 当前采用保守只读/发现策略，缺少原文恢复协调器时不会擅自认领或删除数据。

## 验证命令

```bash
npm run typecheck
npm run build
npm run rag:test
npm run rag:ingest:mock
```

`npm run rag:milvus:init` 和 `npm run rag:ingest` 不会在缺少真实配置时自动连接服务。
它们也不会删除 Collection 或旧版本数据。

