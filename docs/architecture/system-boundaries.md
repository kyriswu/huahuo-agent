# huahuo-agent 系统边界与服务交互

## 目标

`huahuo-agent` 是花火 AI App 的独立 Agent 服务，负责模型调用、工具、记忆和工作流。
`huahuo-server` 管理用户、笔记、文件和知识库，并提供授权后的检索结果。

当前仓库保留 `src/mastra` 下的天气 Agent、Tool 和 Workflow 作为 smoke test。

## 服务职责

### huahuo-server

- 用户、身份认证、租户和权限判定。
- 笔记、文章、知识库、订阅和分享等业务实体。
- 文件资产、对象存储地址和原始文件元数据。
- 验证 Agent 请求的身份，通过受信入口传递用户与会话标识。
- 提供私有知识库检索 API，负责可见性校验和索引选择。

### huahuo-agent

- Mastra Agent、Tool、Workflow、Memory 和运行状态。
- 聊天历史、thread/resource 关联和上下文裁剪。
- 将知识库查询与已验证的用户上下文传给 Server。
- 提供独立的切片、Embedding 和入库状态验证工具。
- 通过 API/SSE 提供 Agent 调用和流式结果。

## 可信边界

```text
客户端
  -> 受信入口调用 Server 验证用户和会话
  -> Agent 将受信身份写入 Mastra 请求上下文
  -> Agent 知识库工具调用私有 Server RAG API
  -> Server 校验权限并检索活跃索引
```

知识库工具接收查询文本、检索模式和数量上限。Server 根据受信用户与会话决定授权范围。

## 服务交互

### 独立入库工具

仓库中的入库、状态迁移和恢复检查通过命令行运行。详见 [RAG 检索与独立入库工具](rag-implementation-plan.md)。

### Agent 请求

1. 受信入口传入已验证的用户与会话，Agent 用用户身份限制 Mastra Memory 的资源范围。
2. Agent 读取 Mastra Memory 中的历史并按上下文预算裁剪。
3. 知识库工具通过 `RagClient` 调用 Server，沿用请求身份和取消信号。
4. Server 返回排序后的文本片段、来源和检索元数据，Agent 将结果交给模型。

## 目录职责

```text
src/mastra/
  Agent、Tool、Workflow 和 Memory 注册

src/application/
  独立 RAG 工具的切片、入库和索引版本切换

src/adapters/
  独立 RAG 工具的 Embedding 和 PostgreSQL 持久化

src/server/
  Server HTTP 客户端和检索契约

src/extensions/huahuo/
  花火配置、默认组合、事件名称和服务地址适配
```

只有存在真实用例或适配器时才新增文件，不提前创建空的 domain、repository 或 service 层。

## Mastra 集成边界

Agent、Tool、Workflow、Memory、认证中间件和 Studio 路由在运行时集成层使用 Mastra。
工具入口从框架上下文提取已验证的花火身份，将身份、业务参数和取消信号传给 Server 客户端。
业务用例、契约、存储适配器、配置和 Server 客户端可独立加载。
`test/framework-boundaries.test.ts` 在 CI 检查这些模块的直接和间接 Mastra 导入。

## 记忆与 RAG 的边界

Mastra Memory 保存对话消息、thread/resource 关联和用户工作记忆。Server 的 RAG 存储保存
文档切片、索引版本和检索元数据。
