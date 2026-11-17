# Server Client 与 traceId 发布验收（2026-11-17）

发布计划为 `20261117-server-clients-trace`。基准取测试环境上次真实成功的 `b32fa300f755b5217e7cd74f9f5ab3913b3177fa`：Actions [43913118355](https://github.com/kyriswu/huahuo-agent/actions/runs/43913118355) 的固定云命令报告五阶段 5/5、`TEST_RELEASE_OK`；对应准确 test push CI 为 43912960914。宿主执行器在发布锁内再次核对基准。本文件记录候选准备结果，本期实际切换以新发布工作流和宿主成功记录为准。

## 变更与兼容

Server 调用统一为公共 HTTP 层、RAG/Studio 业务 Client、Agent 工具三层。复用现有 Server origin、Node 原生 fetch 连接池与 trace 上下文；超时和取消覆盖响应体读取。HTTP 层校验 `success/data/error/traceId`，保留状态、错误码、traceId 和可选 retryable 提示，但不自动重试。RAG 工具返回校验后的业务 data，保留检索元数据；删除旧客户端与没有实际调用的 system 请求入口，不保留兼容分支。

用户/会话身份只来自 Mastra 保留的已验证上下文，发送四个可信头，不发送 JWT 或 ServiceKey。工具和 RAG Client 拒绝额外身份字段，缺少身份在发请求前报错。Studio 登录/SMS 继续显式匿名并保留幂等键，统一使用公共 HTTP 层和请求取消信号。

沿用 `X-Trace-Id`，与 Server 同为 6–96 位字母/数字及 `._:-` 格式。Mastra 请求和原生公开登录处理器建立隔离上下文并回传该头；RAG、登录、模型网关、Web 工具与 Embedding 透传，已有第三方内部重试复用请求 ID。Mastra 保留 ConsoleLogger 及 child/级别/例外处理，只在请求内追加 traceId；非请求日志不伪造业务 trace。第三方是否记录该头不作保证。

没有依赖升级、模型配置、手写 SQL、额外迁移、回填或 Skill 变更。Mastra 仍在启动时初始化/管理共享 PostgreSQL 表；应用恢复不撤销已经提交的数据库变化。只发布 Agent，不操作 Server、其他项目、Nginx、证书或网络。

## 配置与人工准备

配置使用 `reuse`，复用上一成功的不可变快照。新增、修改、改名、停用 ENV 均无，无需手动调整或准备候选值。`HUAHUO_SERVER_BASE_URL` 及 Studio、数据库、模型配置沿用目标现值，不提交真实配置或凭据；无值修改，因此没有新增配置断言脚本。

## 验证与边界

本地类型检查、344 项全量测试、`pnpm build --studio`、构建产物 HTTP 验收和确定性 RAG mock 验收通过。测试覆盖并发身份/trace 隔离、输入身份注入拒绝、响应信封与数据校验、HTTP 200 的业务失败、安全错误、零重试，以及本地真实 HTTP 响应体超时和取消。构建产物检查覆盖 Studio HTML/资源、Cookie 会话能力、原生 Bearer 能力和匿名 API 401。

构建与测试隔离真实配置，使用内存存储、本地 HTTP 和模型替身；确定性 RAG 脚本直接运行，不读取本地 `.env`。未发送真实短信、调用付费模型或访问共享数据库。目标发布仍执行依赖就绪预检、框架存储初始化、候选验收、容器切换、冒烟清理；健康与匿名拒绝检查不代表真实用户、模型质量或数据库持久化验收。Studio 更新允许断开重登，恢复保留当前与上一个成功镜像/配置及已提交存储变化。
