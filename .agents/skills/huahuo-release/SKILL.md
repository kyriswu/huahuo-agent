---
name: huahuo-release
description: 为花火 Agent 准备、审查和执行 Kubernetes 发布，核对准确 CI、镜像摘要、集群配置和回退证据。
---

# 花火 Agent Kubernetes 发布

先读 `AGENTS.md` 和 [Kubernetes 发布](../../../docs/runbooks/standard-release.md)。
普通开发通过 Agent CI。线上操作需要已有会话授权和明确的目标 context、namespace、环境及镜像摘要。

- 从受保护 main 手动发起测试发布，用通过 push CI 的准确 test SHA 构建镜像、推送 ACR 并按摘要更新 Kubernetes。记录源码 SHA、平台和不可变摘要。
- 在已有 GitHub Environment 和受信 runner 上手动发布。核对目标的 ConfigMap、Secret 键名、网关信任规则和数据库角色。凭据保留在既有授权渠道。
- 核对当前 Deployment 实际运行的上一成功摘要及配置，审查新旧版本的存储兼容性。Mastra 初始化自身 PostgreSQL 表。
- 等待 rollout，核对实际镜像和 Agent 冒烟。区分替身、隔离环境与目标实测。完成测试环境验收后，生产使用同一摘要和生产审批。
- 失败先查当前 rollout 和 Pod 事件。回退应用使用同一发布入口和上一成功摘要。
