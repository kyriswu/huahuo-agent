# Agent 标准发布

本仓库使用与 huahuo-server 相同的 Git 发布机制，运行目标为同一台已授权测试机的 `/root/huahuo-agent`。Agent 使用独立 Compose 项目、镜像、宿主锁、状态目录、RAM 角色和云助手命令，不能复用 Server 的固定发布命令。Nginx、域名和证书由宿主管理。

main 的控制流程接受准确 test push CI 的 workflow_run；手动 dispatch 保留作恢复。先验证仓库、事件、CI 路径、运行 ID、当前双 SHA 和合并 PR 的完整文件清单，再取得 OIDC 短期身份。main/test 移动、文件清单不完整或业务变更缺计划均失败；不运行 test 的 runner 控制脚本、不消费不可信缓存/产物。发布串行且不取消在途发布，只调用一次云命令。

## 计划和配置

`scripts/release/plan.json` 记录实际成功基准、agent 角色、存储边界、配置操作、兼容判断和验收级别。首次尚无运行服务/成功记录时 `baseRevision:null`；后续必须填写宿主成功记录中的完整 SHA，宿主锁内再次比对。不能以 origin/main 或 origin/test 冒充已部署版本。

初次配置用 `/root/huahuo-agent/.env`，已有成功配置的值修改提前准备 `.env.candidate`；`configuration.mode:reuse` 复用上一成功快照。真实值不提交。ENV 值修改提供本期 `scripts/release/changes/<id>/verify-config.mjs`，脚本仅做本地断言，在 `--network none` 的候选镜像中限时执行，不输出配置值。

发布冻结一份权限 0600 的配置快照，候选和正式容器使用同一份。测试要求 `APP_ENV=test`，保持端口仅监听回环；Server/JWKS 使用既有容器网络地址，数据库使用原有配置，不重置凭据。

## Agent 的存储边界

Mastra 的 PostgresStore 在启动时初始化/升级自己的表。第二阶段启动候选即可能写入共享数据库，失败或应用回退不会撤销这些变化；框架升级前须审查旧版兼容。`migrations/0003_rag_state.sql` 等属于旧的独立 RAG 工具，自动发布不运行它们，也不调用 `rag:state:migrate`。计划出现额外迁移、数据修正或旧 SQL 改动会阻断，需要先形成独立的受审方案。

第一期只增加原生记忆 JSON、工具和 Skill，不新增手写 SQL；Mastra 包版本和配置沿用当前工作区。兼容检查与替身测试不证明真实模型输出质量或共享数据库并发，相关边界在 PR 和验收记录中说明。

## 五阶段

1. **预检构建与配置**：锁定目标和双 SHA、检查实际基准、磁盘及现有目录；从固定 Git 提交导出源码，构建完整 SHA 镜像；用不可变 ENV 快照运行本期本地配置断言。
2. **Mastra 存储初始化**：以相同配置启动独立候选，使用回环随机端口；由原有框架执行初始化，无额外 RAG SQL。
3. **候选验收**：候选健康响应必须为 200 和 `success:true`，保留启动结果；只证明 HTTP 进程。
4. **容器切换退出**：main Compose 只更新 agent，使用候选镜像和同一配置；旧容器按现有 60 秒停止预算退出。单一固定监听端口，允许短暂中断，不承诺无损排空。
5. **冒烟清理**：正式容器通过固定本地 GET /health 后才记录成功、删除本次临时候选，并清理本项目未使用且不属当前/上一成功版的镜像。没有生产模型、短信或用户数据操作。

宿主入口独立安装在 `/usr/local/sbin/huahuo-agent-test-release`；结果、配置快照和受限日志存于 `/var/lib/huahuo-agent-test-release`。当前和上一个成功版本的镜像/配置保留。日志、云命令输出不公开 ENV、JWT、响应正文或原始异常；Actions 只接受同实例、同命令、同调用及准确 SHA 的完整终态。

收到远端阶段证据才显示 N/5；调用前失败不造阶段进度。只见终态则明确终态复核。超时不自动重发，远端可能仍在运行。失败保留证据和已执行存储变化；恢复用上次成功镜像与对应配置，先确认当前 schema 仍兼容，不运行旧迁移器或撤销数据库变化。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build --studio
pnpm rag:acceptance:dense:mock
pnpm release:check
```

CI 不读取真实 .env 或 secrets，使用模拟模型、隔离内存适配器和云 API fixtures。`release:smoke` 只允许进程内的固定本地 health URL，4 秒上限和 4 KiB 响应限制；健康不代表 Server、认证业务、模型付费调用或数据库持久化已验证。

GitHub test/production 仅允许 main 控制流程。OIDC Provider 复用已验证的 GitHub issuer（阿里云同一账号 issuer URL 唯一），Agent 使用独立 RAM 角色和精确 Agent 仓库/environment subject。角色只允许对确认的实例和 Agent 固定命令 InvokeCommand、DescribeInvocationResults；不新增长期 AK 或 GitHub token。正式生产尚未接入。
