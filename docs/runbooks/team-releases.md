# 团队发布

| 操作 | 规则 |
| --- | --- |
| 业务开发 | PR 合入 `test`，通过 `Agent CI` |
| 发布流程和发布 Skill | 由 owner 审核合入受保护的 `main`，随后同步 `test` |
| 测试环境 | 工作流与环境配置就绪后，从受保护 `main` 手动触发。选择通过 push CI 的准确 `test` SHA，推送 ACR 后按摘要更新账号 `1472289886746775` 的 ACK |
| 生产环境 | 通过生产审批，将已验证的测试镜像摘要发布到生产 |

代码合并只运行 CI。接入时检查实际 GitHub ruleset、Environment 审批、runner 标签和 kubeconfig 身份。仓库里的规则样例用于对照。操作步骤见 [Kubernetes 发布](standard-release.md)。
