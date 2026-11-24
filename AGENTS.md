# 花火 Agent

只在本仓库开发 Agent；`../huahuo-server` 为业务 Server 和发布流程参考，不修改其他项目。
Node 26.11.0 / pnpm 10.15.1 / TypeScript / Mastra；运行配置与凭据不提交 Git。

业务用例、业务契约、适配器、扩展配置和 Server 客户端只能依赖框架无关的输入输出。
Mastra 的类型、上下文、注册和生命周期留在运行时集成层；进入业务边界前提取已验证的身份、参数和取消信号。
`test/framework-boundaries.test.ts` 检查这些模块的直接及间接 Mastra 依赖。
替换实现时，核实调用方后移除废弃入口和配置。需继续支持的兼容逻辑要有明确的调用方和测试。

发布准备使用 `.agents/skills/huahuo-release/SKILL.md` 和 `docs/runbooks/standard-release.md`。
本地开发分支为 `test`，业务通过 PR 合入 test。Kubernetes 镜像构建和发布由受保护 main 手动触发。main 由 owner 合并。
实际权限以 GitHub rulesets/environment 为准，不把仓库文件存在当成已生效。
测试发布目标为阿里云账号 `1472289886746775` 内已授权的 Agent ACK context 和 namespace。Server、入口网关及证书由各自部署流程管理。

Mastra PostgreSQL 表由框架启动时管理；不能把旧的 `migrations/` RAG SQL 当成运行服务迁移自动执行。
发布基准取目标 Deployment 实际运行的镜像摘要。
共享数据库不清空、不重置、不回写历史迁移。CI 使用隔离替身，不继承真实配置，不调用短信、模型或付费服务。
发布失败先查 rollout、Pod 事件和实际运行镜像。应用回退沿用上一成功摘要，并保留已经提交的数据库变化。
