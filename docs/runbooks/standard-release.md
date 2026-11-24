# Agent 发布准备

旧测试 Compose 发布入口已退役。合入 `test` 后运行 Agent CI。测试 ACK 发布由独立流程接入阿里云账号 `1472289886746775`。分支和权限操作见[团队发布](team-releases.md)。

CI 使用 `release:review` 核对干净提交、计划结构、兼容判断、基准祖先、冻结迁移和审查文件。兼容项含 `false` 的候选仍可完成测试与构建，需要在部署前另行处理。 `release:check` 执行完整的兼容性检查。

## 计划和配置

`scripts/release/plan.json` 记录实际成功基准、Agent 角色、存储边界、配置操作、兼容判断和验收级别。首次尚无成功记录时使用 `baseRevision:null`。后续按目标实际成功记录填写完整 SHA。

配置值通过已授权的私密来源准备。 `configuration.mode:reuse` 复用上一成功快照。ENV 值修改提供本期 `scripts/release/changes/<id>/verify-config.mjs`，脚本执行限时的本地断言。候选与正式实例使用同一份配置。测试环境使用 `APP_ENV=test`，Server 使用部署方维护的稳定内网入口。

## Agent 的存储边界

启动候选时，Mastra 的 PostgresStore 可能初始化或升级自己的表。回退应用会保留已提交的存储变化，框架升级前须审查旧版兼容。涉及额外迁移、数据修正或旧 SQL 修改时，先准备独立的受审方案。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build --studio
pnpm rag:acceptance:dense:mock
pnpm release:review
pnpm release:check
```

CI 使用模拟模型、隔离内存适配器和云 API fixtures。目标环境另行验证 HTTP 健康、匿名拒绝、真实用户和归属、Server 私网契约、模型输出及持久化。记录实际发布 SHA 和运行镜像摘要。

失败时先核对既有执行记录、运行版本和存储状态。恢复使用上一成功镜像及对应配置，并确认当前 schema 兼容。旧发布的故障证据见[轻量发布诊断历史记录](release-diagnostics.md)。

## 统一入口契约

Agent 沿用可信身份头和原生 Mastra 资源隔离。Studio 登录继续由 Agent 提供 UI，跳转、刷新、退出由 Server 与入口处理。

`HUAHUO_SERVER_BASE_URL` 使用稳定内部 origin，`HUAHUO_STUDIO_ORIGIN` 使用浏览器 origin，`HUAHUO_AGENT_PUBLIC_PATH=/agent` 需与入口一致。Nginx、域名及证书由部署方管理。
