---
name: huahuo-release
description: 为花火 Agent 准备、审查、执行测试发布或恢复失败发布，整理实际部署基准、Mastra 存储兼容、配置、发布清单与验收证据；普通功能开发不自动触发部署。
---

# 花火 Agent 发布

先读 `AGENTS.md`、[标准发布](../../../docs/runbooks/standard-release.md)；分支和权限操作另读[团队发布](../../../docs/runbooks/team-releases.md)。参考 Server 的同一流程，使用 Agent 自己的入口和目标，不调用 Server 发布命令。

旧测试发布入口已退役。当前合并运行 Agent CI，测试 ACK 发布通过独立受审流程接入账号 `1472289886746775`。

核对本地改动和目标实际成功 SHA。以该 SHA 到候选的累计差异评估 API、认证、模型配置、Mastra 表结构/存储版本、资源级记忆、工具与 Skill 文件。没有成功记录则基准为 null；Git 分支头不等于实际部署。保护未提交工作，按会话授权处理是否统一提交。

更新 `scripts/release/plan.json`，记录配置逐键操作、默认/必填、准备位置和验证方式。值修改提供本期 `verify-config.mjs`；只断言本地 ENV，不访问网络、数据库或付费服务，不输出秘密。实际配置由授权私密来源准备，同一快照贯穿构建后检查、候选和正式容器。

Mastra 启动会初始化/升级配置的 PostgreSQL 表；审查框架升级和旧版兼容，不把它描述成零数据库写入。旧 `migrations/` 属于独立 RAG 脚本。涉及额外结构调整或回填，先评估范围、锁、幂等和恢复，并落实经过审查的执行方案。

运行 typecheck、相关测试、`pnpm build --studio`、`pnpm release:check` 和确定性验收。区分替身、隔离真实依赖和目标实测；健康检查只证明 HTTP 进程，不证明模型、Server、鉴权业务或数据库持久化成功。

业务 PR 合入 test 前启用 GitHub 原生 Auto-merge，由 CI/审核条件决定合并。main 不自动合并，由 owner 操作；流程/Skill 变更先经 main 审核，再通过 PR 同步 test。发布准备使用通过同 SHA push CI 的 test 业务与计划，核对合并 PR 的完整文件范围。

最终 PR 按模板说明功能、范围、冲突解决（无则明确无）、逐键 ENV、人工准备时点与状态、验证范围和恢复限制。发布 Skill 及 CODEOWNERS 的专属审核不扩展到其他 Skill。GitHub rulesets、environment 和 RAM 执行权限，Skill 本身不是权限控制。

测试发布使用当前会话已有授权，不重复索取同一动作批准。仅在缺少实际目标/配置或出现超出授权的动作时澄清。云身份使用短期 STS，按 Agent 专用资源和任务限定权限。production 仅准备摘要和 owner 审批门禁。

只报告收到的验证与部署证据。失败先查看既有执行记录，保留当前和上一个成功镜像、配置与已提交存储变化。
