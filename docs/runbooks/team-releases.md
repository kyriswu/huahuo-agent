# 团队发布

沿用 `huahuo-server` 的分支与权限模型：

| 操作 | 规则 |
| --- | --- |
| 业务开发 | 本地 test；通过 PR 合入 test |
| test 合并 | strict `Agent CI`、禁止删除/强推；原生 Auto-merge 等待规则满足 |
| main 合并 | owner 操作 PR；同样必须通过 CI，不自动合并 |
| 测试验收 | test 合入后运行同 SHA 的 Agent CI，ACK 发布流程由独立 PR 接入 |
| 流程控制 | main 提供受保护的流程代码，test 提供业务及验收计划 |
| 生产 | 仅 readiness；production 审批人为 kyriswu，未接生产执行器 |

test/production environments 只允许 main 分支、零标签，关闭管理员绕过。main 的 owner 例外仅适用于独立 update 限制，不能绕过原 PR 和 CI。Skill/CODEOWNERS 单独要求 owner 审核；其他 Skill 不新增专属审核。

规则定义保存在 `.github/rulesets/`，检查名按本仓库改为 `Agent CI`。文件存在不等于 GitHub 配置成功，实际状态以 API 回读和验收记录为准。

每期从实际成功部署 SHA 整理变更，更新 `scripts/release/plan.json` 和 PR 模板。业务/SQL/ENV/技能资产变化都需要计划更新。只有文档、Codex 发布 Skill 和已知控制文件同步可跳过应用部署；重命名的原路径也检查。首次配置 main/test 时的分支创建不当作合并业务 PR 自动部署。

main/test 同步通过 PR，不强推。控制与发布 Skill 变更先由 owner 合入 main，再同步 test。生产基准保持 null，readiness 或审批演练通过都不等于生产发布成功。

验收依据实际的 test SHA、CI 结果和目标环境证据。遇到部署故障时，先核对既有执行记录和运行状态，再决定如何恢复。
