# huahuo-agent 系统边界与服务交互

## 目标

`huahuo-agent` 是花火 AI App 的独立 Agent 服务。它负责 Agent 运行时能力和派生的检索索引能力，不复制 `huahuo-server` 的用户、笔记、文件和知识库业务模型。

当前仓库是已初始化的 Mastra 项目，保留现有 `src/mastra` 下的天气 Agent、Tool 和 Workflow 作为 smoke test。RAG 通过独立的 Application Service 实现，再由 Mastra Tool 调用。

## 服务职责

### huahuo-server

- 用户、身份认证、租户和权限判定。
- 笔记、文章、知识库、订阅和分享等业务实体。
- 文件资产、OSS 地址和原始文件元数据。
- 产生文档变更事件，或者调用 Agent 的索引 API。
- 在每次 Agent 请求前提供可信的授权范围。
- 保存必要的业务会话索引、归属和权限元数据。

`huahuo-server` 是文章正文、文件和知识库归属的权威来源。Agent 不应接受客户端直接提交的 `ownerId`、`tenantId` 或知识库列表作为授权依据。

### huahuo-agent

- Mastra Agent、Tool、Workflow、Memory 和运行状态。
- 聊天历史、thread/resource 关联和上下文裁剪。
- RAG 文档入库、切片、索引版本和检索编排。
- Embedding、Rerank、Milvus 和业务 API Adapter。
- 通过 API/SSE 提供 Agent 调用和流式结果。
- 在需要时通过 `assetId` 或来源引用从 `huahuo-server` 获取原文。

Agent 保存的是派生索引和运行时数据。全文缓存如果存在，也必须标记为可删除、可重建的派生副本。

## 可信边界

授权链路如下：

```text
客户端
  -> huahuo-server 认证与授权
  -> huahuo-server 签发 Agent 请求上下文/授权票据
  -> huahuo-agent 校验票据并取得 allowedKnowledgeBaseIds
  -> RAG Application Service 构造不可变过滤条件
  -> Milvus Hybrid Search
```

Agent 服务可以重新向业务服务查询授权范围。仅把客户端传入的知识库 ID 放进 Milvus filter 不构成安全边界。

## 服务交互

### 文档索引

1. `huahuo-server` 创建或更新文章、文件或知识库关联。
2. 业务服务提交 `sourceId`、`sourceType`、稳定 `documentId`、`documentVersion`、`contentHash` 和授权上下文。
3. Agent 从业务服务获取正文或文件解析结果，不把业务资产迁移为 Agent 的主数据。
4. Agent 预处理、切片、Embedding，并写入 Milvus 的新索引版本。
5. 所有切片完成并通过一致性检查后，Agent 标记该版本为 `ready`。
6. 业务服务或 Agent 的版本状态接口将可见版本切换到新版本。
7. 旧版本保留到清理任务确认新版本可用后再删除。

### Agent 请求

1. 业务服务传入 `threadId`、`resourceId`、用户身份和授权上下文。
2. Agent 读取 Mastra Memory 中的历史，按上下文预算裁剪。
3. Agent Tool 调用 RAG Application Service。
4. RAG 服务执行 Milvus Hybrid Search、外部 Rerank 和按文档聚合。
5. 如需全文，Agent 通过来源 Adapter 从业务服务加载，或读取带版本标识的派生缓存。
6. Agent 将结构化检索结果交给模型，并通过 SSE 输出阶段事件和最终文本。

## 目录职责

```text
src/mastra/
  Agent、Tool、Workflow、Memory 注册；Tool 只负责参数校验和调用 Application Service

src/application/
  RAG 入库、索引版本切换、Hybrid Search、Rerank、文档聚合等用例

src/adapters/
  Milvus、Embedding、Rerank、huahuo-server API、全文读取和持久化实现

src/contracts/
  跨服务请求/响应 DTO、授权上下文、事件和错误契约

src/server/
  HTTP/SSE 路由、认证票据校验、请求上下文组装和流式输出

src/extensions/huahuo/
  花火配置、默认组合、事件名称和服务地址适配
```

不在本阶段新增空的 domain、repository、service 等层。只有存在真实用例或适配器时才新增文件。

## 记忆与 RAG 的边界

Mastra Memory 保存对话消息、thread/resource 关联、上下文窗口和 Agent 执行状态。RAG 保存文档切片、索引版本和检索元数据。聊天消息不能作为知识库切片自动混入 RAG；知识库文档也不能直接充当聊天历史。

后续扩展点包括：

- `threadId` 和 `resourceId` 稳定映射到业务会话索引。
- 上传文件通过 `assetId` 在后续轮次引用。
- `replyToMessageId` 仅作为消息引用，不复制正文。
- Tool 调用和 Workflow 状态通过 Mastra 状态恢复。
- 进程重启后继续读取 Mastra Memory 和未完成任务状态。

## 参考依据

- [Mastra Core Agent model configuration](https://github.com/mastra-ai/mastra)
- [Milvus multi-tenancy](https://milvus.io/docs/multi_tenancy.md)
