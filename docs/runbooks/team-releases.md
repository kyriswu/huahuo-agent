# 团队发布

沿用 `huahuo-server` 的分支与权限模型：

| 操作 | 规则 |
| --- | --- |
| 业务开发 | 本地 test；通过 PR 合入 test |
| test 合并 | strict `Agent CI`、禁止删除/强推；原生 Auto-merge 等待规则满足 |
| main 合并 | owner 操作 PR；同样必须通过 CI，不自动合并 |
| 测试发布 | test 同 SHA push CI 成功，触发 main 中的 `Test server release` |
| 流程控制 | 工作流、调用器、依赖和 Compose 来自 main；业务及发布计划来自 test |
| 生产 | 仅 readiness；production 审批人为 kyriswu，未接生产执行器 |

test/production environments 只允许 main 分支、零标签，关闭管理员绕过。main 的 owner 例外仅适用于独立 update 限制，不能绕过原 PR 和 CI。Skill/CODEOWNERS 单独要求 owner 审核；其他 Skill 不新增专属审核。

规则定义保存在 `.github/rulesets/`，检查名按本仓库改为 `Agent CI`。文件存在不等于 GitHub 配置成功，实际状态以 API 回读和验收记录为准。

每期从实际成功部署 SHA 整理变更，更新 `scripts/release/plan.json` 和 PR 模板。业务/SQL/ENV/技能资产变化都需要计划更新。只有文档、Codex 发布 Skill 和已知控制文件同步可跳过应用部署；重命名的原路径也检查。首次配置 main/test 时的分支创建不当作合并业务 PR 自动部署。

main/test 同步通过 PR，不强推。控制与发布 Skill 变更先由 owner 合入 main，再同步 test。生产基准保持 null，readiness 或审批演练通过都不等于生产发布成功。

失败先看已有云助手调用和宿主记录，确认是否已经写库、启动候选、换容器。手动 `workflow_dispatch` 仅作恢复，仍核对准确 test push CI、main 控制 SHA 与配置；不靠无关文档提交重试。
