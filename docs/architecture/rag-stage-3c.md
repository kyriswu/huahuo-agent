# 第三阶段 C：真实 Dense RAG 验收流程

本阶段新增可重复执行的 Dense RAG 验收脚本：

```bash
npm run rag:acceptance:dense:mock
npm run rag:acceptance:dense -- --mode=real
```

两种模式严格区分。Mock 模式使用确定性的测试向量和内存 Repository，只验证切片、入库
编排、幂等、失败恢复和版本状态转换；它不连接 Milvus，也不调用真实 Embedding Provider，
不能作为真实 Dense RAG 通过证据。Real 模式必须显式设置：

```env
RAG_ACCEPTANCE_ALLOW_REAL=true
RAG_ACCEPTANCE_ALLOW_WRITES=true
RAG_ACCEPTANCE_ENVIRONMENT_TARGET=milvus-huahuo-test
```

脚本还会核验授权的 Milvus 外网地址、`default` 数据库、正式 Collection
`huahuo_chunks`、Embedding 模型和向量维度。Schema 或目标不匹配时停止，不删除或重建
Collection；缺少模型、凭证、网络或其他前置条件时返回 `BLOCKED`（退出码 2）。真实请求
失败或断言失败返回 `FAIL`（退出码 1），安全目标不匹配返回 `SAFETY_ABORT`（退出码 4），
验收程序或报告生成异常返回 `ERROR`（退出码 3）。

每次运行生成唯一 `runId`，真实写入行包含该运行标识；脚本不会清空 Collection 或删除其他
运行的数据。报告保存在：

```text
artifacts/rag-acceptance/latest.json
artifacts/rag-acceptance/latest.md
artifacts/rag-acceptance/runs/<run_id>.json
artifacts/rag-acceptance/runs/<run_id>.md
```

报告记录每项检查的状态、是否使用 Mock、耗时和脱敏证据。运行报告目录默认被 `.gitignore`
忽略，避免提交运行数据。

当前工作区没有本地 `.env` 和真实 API Key；虽然 `.env.example` 已记录 SiliconFlow
Endpoint、`BAAI/bge-m3` 和 1024 维配置，真实模式仍会在外部写入前报告 `BLOCKED`。
状态层已增加 `PostgresDocumentVersionStore` 和显式迁移命令，但是否通过真实持久化验收
取决于授权测试 PostgreSQL 是否配置并实际执行迁移。`npm run rag:state:process-check`
可在两个或更多独立 Node.js 进程中验证状态读取、幂等租约和版本切换；它只验证
PostgreSQL 状态，不冒充 Milvus 跨库恢复。完整 Dense 真实验收仍需真实 Embedding、
Milvus 正式 Collection、测试 PostgreSQL 和授权开关全部就绪。

本阶段仍不实现 BM25、Hybrid Search、RRF、Rerank 或生产业务接口；PoC Collection
`huahuo_rag_poc_dense` 保持独立且不被清理。
