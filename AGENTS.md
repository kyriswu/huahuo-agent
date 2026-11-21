# 花火 Agent

只在本仓库开发 Agent；`../huahuo-server` 为业务 Server 和发布流程参考，不修改其他项目。
Node 26.11.0 / pnpm 10.15.1 / TypeScript / Mastra；运行配置与凭据不提交 Git。

业务用例、业务契约、适配器、扩展配置和 Server 客户端只能依赖框架无关的输入输出。
Mastra 的类型、上下文、注册和生命周期留在运行时集成层；进入业务边界前提取已验证的身份、参数和取消信号。
`test/framework-boundaries.test.ts` 检查这些模块的直接及间接 Mastra 依赖。
替换实现时，核实调用方后移除废弃入口和配置。需继续支持的兼容逻辑要有明确的调用方和测试。

发布准备使用 `.agents/skills/huahuo-release/SKILL.md` 和 `docs/runbooks/standard-release.md`。
本地开发分支为 `test`；业务通过 PR 合入 test，准确提交的 Agent CI 成功后由受保护 main 自动发布测试环境。main 由 owner 合并。
实际权限以 GitHub rulesets/environment 为准，不把仓库文件存在当成已生效。
目标仅为已授权测试机的 `/root/huahuo-agent`、独立 Compose 项目及云助手命令，不操作 Server 容器、其他项目、Nginx 或证书。

Mastra PostgreSQL 表由框架启动时管理；不能把旧的 `migrations/` RAG SQL 当成运行服务迁移自动执行。
发布基准取宿主实际成功记录；没有部署记录用 null，不以 Git 分支头代替。
共享数据库不清空、不重置、不回写历史迁移。CI 使用隔离替身，不继承真实配置，不调用短信、模型或付费服务。
发布失败先查已有调用和容器状态，不自动重发云命令；回退应用不撤销已经完成的数据库变化。
