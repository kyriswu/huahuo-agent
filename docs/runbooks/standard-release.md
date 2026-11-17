# Agent 标准发布

本仓库使用与 huahuo-server 相同的 Git 发布机制，运行目标为同一台已授权测试机的 `/root/huahuo-agent`。Agent 使用独立 Compose 项目、镜像、宿主锁、状态目录、RAM 角色和云助手命令，不能复用 Server 的固定发布命令。Nginx、域名和证书由宿主管理。

main 的控制流程接受准确 test push CI 的 workflow_run；手动 dispatch 保留作恢复。先验证仓库、事件、CI 路径、运行 ID、当前双 SHA 和合并 PR 的完整文件清单，再取得 OIDC 短期身份。main/test 移动、文件清单不完整或业务变更缺计划均失败；不运行 test 的 runner 控制脚本、不消费不可信缓存/产物。发布串行且不取消在途发布，只调用一次云命令。

代码验收与部署许可分开：CI 使用 `release:review`，核对干净提交、计划结构、兼容判断类型、基准祖先、冻结迁移和审查文件；兼容项为 `false` 的候选仍可完成测试与构建。普通发布继续要求 `release:check` 和宿主门禁全部通过，不把代码 CI 成功等同于允许更新。

自动入口先只读准确 test SHA 的计划 JSON，兼容项为 `false` 时报告 `deferred`，不取得云凭据或调用发布命令；非法或缺失计划仍失败。手动普通发布同样不能跳过兼容门禁。本项目所需的首次维护另行准备，不向自动路径添加临时兼容分支。上述控制修改需经 main 审核合入再同步 test，本地文件变化不代表线上流程已更新。

## 计划和配置

`scripts/release/plan.json` 记录实际成功基准、agent 角色、存储边界、配置操作、兼容判断和验收级别。首次尚无运行服务/成功记录时 `baseRevision:null`；后续必须填写宿主成功记录中的完整 SHA，宿主锁内再次比对。不能以 origin/main 或 origin/test 冒充已部署版本。

初次配置用 `/root/huahuo-agent/.env`，已有成功配置的值修改提前准备 `.env.candidate`；`configuration.mode:reuse` 复用上一成功快照。真实值不提交。ENV 值修改提供本期 `scripts/release/changes/<id>/verify-config.mjs`，脚本仅做本地断言，在 `--network none` 的候选镜像中限时执行，不输出配置值。

发布冻结一份权限 0600 的配置快照，候选和正式容器使用同一份。测试要求 `APP_ENV=test`，保持端口仅监听回环；Server 使用部署方维护的稳定内网入口，不绑定单个发布实例，数据库使用原有配置，不重置凭据。

## Agent 的存储边界

Mastra 的 PostgresStore 在启动时初始化/升级自己的表。第二阶段启动候选即可能写入共享数据库，失败或应用回退不会撤销这些变化；框架升级前须审查旧版兼容。`migrations/0003_rag_state.sql` 等属于旧的独立 RAG 工具，自动发布不运行它们，也不调用 `rag:state:migrate`。计划出现额外迁移、数据修正或旧 SQL 改动会阻断，需要先形成独立的受审方案。

第一期只增加原生记忆 JSON、工具和 Skill，不新增手写 SQL；Mastra 包版本和配置沿用当前工作区。兼容检查与替身测试不证明真实模型输出质量或共享数据库并发，相关边界在 PR 和验收记录中说明。

## 五阶段

1. **预检构建与配置**：锁定目标和双 SHA、检查实际基准、磁盘及现有目录；从固定 Git 提交导出源码，构建完整 SHA 镜像；用不可变 ENV 快照运行本期本地配置断言。候选镜像仅携带内部Server地址，在Agent原有网络调用固定 `GET /health/ready` 和匿名 `GET /internal/v1/gateway/auth`，分别要求业务就绪及401。失败在初始化存储前停止，不查询Server提交、发布记录或容器。
2. **Mastra 存储初始化**：以相同配置启动独立候选，使用回环随机端口；由原有框架执行初始化，无额外 RAG SQL。
3. **候选验收**：固定本地 `/health` 必须为 200 和 `success:true`，匿名 `/api/agents` 必须为401。保留启动结果；这不证明真实用户、模型或数据持久化。
4. **容器切换退出**：main Compose 只更新 agent，使用候选镜像和同一配置；旧容器按现有60秒停止预算退出。切换前核验上一成功配置摘要、镜像和控制Compose，预留恢复时间。替换或正式实例健康失败时，在同一发布锁内用上一成功镜像与原配置恢复，不运行迁移器。单一固定监听端口允许短暂中断，不承诺无损排空。
5. **冒烟清理**：正式实例通过健康及匿名拒绝检查后，原子登记真实容器、应用/控制SHA、镜像ID、配置摘要和退出结果，再清理候选与未使用旧镜像。保留当前和上一成功版；清理失败记录为待清理，不把已切换的实际版本误记成旧版。没有生产模型、短信或用户数据操作。

宿主入口独立安装在 `/usr/local/sbin/huahuo-agent-test-release`；结果、配置快照和受限日志存于 `/var/lib/huahuo-agent-test-release`。当前和上一个成功版本的镜像/配置保留。日志、云命令输出不公开 ENV、JWT、响应正文或原始异常；Actions 只接受同实例、同命令、同调用及准确 SHA 的完整终态。

收到远端阶段证据才显示 N/5；调用前失败不造阶段进度。只见终态则明确终态复核。超时不自动重发，远端可能仍在运行。失败保留证据和已执行存储变化；恢复用上次成功镜像与对应配置，先确认当前 schema 仍兼容，不运行旧迁移器或撤销数据库变化。

发布结果保留已验证的云助手 invocationId。Agent 专用宿主命令可在失败终态附带固定检查项、错误码和可选退出码，由同一调用器写入 Actions Summary；没有新增 Job、云请求或日志上传。诊断缺失/非法明确标注，保留原发布失败，不据此猜测根因或自动重发。协议、开销与宿主补丁见[轻量发布诊断](release-diagnostics.md)。会话已授权范围内的 Agent 日志、原调用和容器状态只读核验直接执行；一个身份/入口失败仅证明该入口不可用，应检查其余已授权路径，全部不足后再说明具体缺少的访问或信息。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build --studio
pnpm rag:acceptance:dense:mock
# CI: review a clean candidate without granting deployment.
pnpm release:review
# Ordinary deployment: every compatibility decision must be true.
pnpm release:check
```

CI 不读取真实 .env 或 secrets，使用模拟模型、隔离内存适配器和云 API fixtures。`release:smoke` 只允许进程内的固定本地 health URL，4 秒上限和 4 KiB 响应限制；健康不代表 Server、认证业务、模型付费调用或数据库持久化已验证。

GitHub test/production 仅允许 main 控制流程。OIDC Provider 复用已验证的 GitHub issuer（阿里云同一账号 issuer URL 唯一），Agent 使用独立 RAM 角色和精确 Agent 仓库/environment subject。角色只允许对确认的实例和 Agent 固定命令 InvokeCommand、DescribeInvocationResults；不新增长期 AK 或 GitHub token。正式生产尚未接入。

## 统一入口切换候选（2026-11-16）

Agent独立发布和恢复，不执行Server发布流程。宿主入口调整独立于应用发布。Agent 的 JWT/ServiceKey 认证已移除，业务沿用可信身份头和原生 Mastra 资源隔离。Studio 登录继续由 Agent 提供 UI，跳转、刷新、退出由 Server 与入口处理；Agent 不再保留另一套退出和匿名导航重定向逻辑。

`HUAHUO_SERVER_BASE_URL` 使用稳定内部 origin，`HUAHUO_STUDIO_ORIGIN` 使用浏览器 origin，`HUAHUO_AGENT_PUBLIC_PATH=/agent` 两端一致。项目只维护应用契约；Nginx 配置与宿主切流脚本位于仓库外。首次候选的api/configuration曾保持false，表示当时新接入契约未验收；首次独立维护完成后，以真实成功基准与已验证配置恢复正常更新。这不代表Server与Agent绑定发布。

## 执行器升级与首次接入

宿主执行器v2与部署代码独立维护，固定云命令仍只接受准确test SHA。它增加Server契约预检、匿名API拒绝检查、同锁恢复和原子成功记录。执行器的候选、备份及无Docker模拟验证记录在宿主维护目录；安装、目标实际执行结果另记，不能把本地测试当成已经替换宿主。

首次从旧JWT/ServiceKey调用方式改为可信身份协议时，候选api/configuration保留false，普通自动入口因此deferred。首次接入由一次性、固定应用/控制SHA与实际基准的独立维护执行；维护先验证Server接口和完整候选配置，仍只操作Agent，不执行Server发布或修改宿主Nginx。完成后登记实际成功SHA，后续版本才以该基准恢复普通自动发布。不存在通用force或跳过数据库兼容的开关。

恢复使用上一成功镜像、不可变配置及旧控制Compose，只能证明原进程恢复；首次接口破坏性接入时，旧二进制未必兼容当前Server，不能把进程健康称为完整业务恢复。数据库已由Mastra提交的变化不会回退。恢复失败保留现场与failure.json，不自动重发发布命令。
