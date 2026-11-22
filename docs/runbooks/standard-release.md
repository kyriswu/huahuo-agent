# 花火 Agent Kubernetes 发布

线上使用阿里云 ACR 和 Kubernetes。手动触发测试发布时，流程先推送镜像到 ACR，再按返回的摘要更新 Deployment。生产复用已验收的同一摘要。代码合并只运行 CI。

## 接入已有集群

1. 确认目标 context、namespace、节点架构、镜像仓库与 runner 到 Kubernetes API 的网络路径。测试和生产分别使用各自的授权与配置。Namespace 由集群运维创建。
2. 在目标 namespace 准备 `huahuo-agent-config` ConfigMap 和 `huahuo-agent-secrets` Secret。Agent 使用独立的持久化 PostgreSQL 数据库。测试和生产各用已确认的目标库。
3. 配置集群拉取私有 ACR 镜像的权限。有现成 ACK 免密拉取配置时可沿用，其他集群可在 Agent 的 ServiceAccount 上挂接预置的 imagePullSecret。应用 Pod 不挂载 Kubernetes API token。 [ACR 私有镜像拉取](https://www.alibabacloud.com/help/en/acr/user-guide/non-secret-pulling-container-image)
4. 核对网关和 Server 的私网流向。Agent 与 Server 在同一 namespace 时可以使用 `http://huahuo-api:3000` 作为 Server origin。Server 需要调用 Agent 模板接口时，对应的私网 origin 是 `http://huahuo-agent:4111`。

### 运行配置

| 放置位置 | 键 | 说明 |
| --- | --- | --- |
| ConfigMap | `HUAHUO_SERVER_BASE_URL` | 可达的稳定 Server 私网 origin，无路径后缀 |
| ConfigMap | `MASTRA_POSTGRES_HOST`、`MASTRA_POSTGRES_DATABASE`、`MASTRA_POSTGRES_USER` | 必须显式指定 |
| ConfigMap | `MASTRA_POSTGRES_PORT`、`MASTRA_POSTGRES_SSL`、`MASTRA_POSTGRES_POOL_MAX` | 按目标数据库配置。端口默认 5432，连接池默认每 Pod 12 |
| ConfigMap | `MODEL_PROVIDER`、模型配置 | 见 `.env.example`，使用现有授权的模型 |
| ConfigMap | `HUAHUO_AGENT_PUBLIC_PATH`、`HUAHUO_STUDIO_ORIGIN`、`HUAHUO_STUDIO_AUTH_ENABLED` | 测试需要 Studio 登录时，与入口和 Server 协调。生产禁用 Studio 和手机登录 |
| ConfigMap | `METRICS_ENABLED`、`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 指标走 Pod 私网端口 9464。外发 Trace 仅在显式提供采集地址后启用 |
| Secret | `MASTRA_POSTGRES_PASSWORD`、所选模型的 API Key | 通过线上凭据管理配置。发布清单和 Git 中只保存 Secret 名称 |

线上 init container 先校验必需配置，再检查 Server 的就绪响应和匿名鉴权拒绝。线上 Agent 强制使用 PostgreSQL，并在开始监听 HTTP 前完成 Mastra 的存储初始化。Kubelet 使用 `/health` 检查 Pod 本身，存储持续可用性和模型调用仍在环境验收中单独验证。

### 网关与网络边界

ClusterIP 的 4111 API 只允许同 namespace 的 Server API Pod 和明确标记 `huahuo.io/agent-trusted=true` 的受信工作负载。网关仍负责校验会话、丢弃客户端提供的身份头、写入受信身份头。公开 `/agent/api` 到内部 `/api` 的映射和测试 Studio 子路径沿用现有协议。网关接入前先验证匿名请求和外部伪造身份头的行为。

Agent Pod 带 `huahuo.io/api-trusted=true`，符合现有 Server K3s 模板的 API 入站策略。9464 仅允许标记 `huahuo.io/metrics-trusted=true` 的同 namespace 采集端。跨 namespace、宿主网关或不同 CNI 的拓扑需要在接入时核对实际流量路径。NetworkPolicy 需要 CNI 执行，节点来源流量另按集群和宿主策略限制。参见 [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)。

## GitHub 发布

1. 在受保护的 `main` 手动运行 **Agent Kubernetes release**，选择 `test`，在 `source_sha` 填入当前 `test` 的完整提交 SHA。流程核对同一 SHA 的成功 push CI，按 SHA 打包并推送到 ACR。
2. 测试部署自动使用这次推送返回的 `sha256:...`。流程先做 Kubernetes 服务端 dry-run，再应用 NetworkPolicy 和工作负载，等待滚动更新，核对容器镜像并验证进程健康和匿名 API 401。记录 Actions 摘要中的源码 SHA、平台和镜像摘要。
3. 验证测试环境的网关路径、Studio、持久化和业务链路。生产手动选择 `production`，在 `image_digest` 填入同一测试摘要，通过生产环境审批后从 ACR 拉取。生产应用关闭 Studio 页面和资源。

| GitHub 位置 | 所需配置 |
| --- | --- |
| 仓库变量 | `AGENT_IMAGE_REPOSITORY`（完整 ACR 地址/命名空间/仓库），`AGENT_IMAGE_PLATFORM`（可选，默认 `linux/amd64`），`AGENT_ACR_BUILD_RUNNER` 和 `AGENT_K8S_RUNNER`（可选已有 runner 标签） |
| 仓库 Secrets | `AGENT_REGISTRY_USERNAME` 和 `AGENT_REGISTRY_PASSWORD`（ACR 镜像推送专用凭据） |
| `test` 和 `production` Environment 变量 | `AGENT_K8S_CONTEXT` 与 `AGENT_K8S_NAMESPACE` |
| `test` 和 `production` Environment Secret | `AGENT_KUBECONFIG`（已授权、有效期内的完整 kubeconfig） |

ACR 和 Kubernetes API 走私网时使用已有可达的 runner。ACR 构建 runner 的 CPU 架构应与 `AGENT_IMAGE_PLATFORM` 一致。也可在可达机器用已有授权 kubeconfig 将 ACR 中的已验摘要部署到指定 namespace。部署身份需要应用清单、监视 rollout 和执行 Pod 冒烟所需权限。保护该身份和目标 namespace 的工作负载写权限。 [ACR 推送凭据](https://www.alibabacloud.com/help/en/acr/user-guide/configure-access-credentials) · [ACK kubeconfig](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/kubeconfig-operation-guide/) · [Kubernetes RBAC 实践](https://kubernetes.io/docs/concepts/security/rbac-good-practices/)

```bash
KUBECONFIG=/path/to/approved-kubeconfig \
AGENT_K8S_CONTEXT=approved-context \
AGENT_K8S_NAMESPACE=approved-namespace \
AGENT_IMAGE_REPOSITORY=registry.example.com/huahuo/huahuo-agent \
scripts/kubernetes/deploy.sh test 'sha256:<verified-digest>'
```

### 回退与存储

每次记录上一成功镜像摘要和使用的配置版本，ACR 保留已使用的摘要。失败先核对 Pod 事件、rollout 状态和实际运行摘要。生产可通过工作流推广上一摘要，测试可使用上面的 `deploy.sh test` 重新部署上一摘要。Mastra 管理自己的表，回退镜像会保留已提交的存储变更。独立 RAG 迁移脚本不参与集群发布。

仅更新 ConfigMap 或 Secret 时，环境变量会在新 Pod 启动时加载。同一摘要下的配置轮换需要对已授权 Deployment 执行滚动重启，再跑验收。

首轮为单副本滚动更新，最多短时并存两个 Agent Pod。确认连接池容量和混合版本期间的存储兼容性。Pod 终止宽限为 60 秒，Mastra 的 HTTP 排空与入口的 SSE 超时仍需结合真实长流量验收。

## 轻量本地验收

日常开发用 `pnpm dev`，代码检查用 `pnpm typecheck` 和 `pnpm test`。需要验证 Kubernetes 启动时，在现有 Docker 上用一个独立 K3s 节点。下面命令不配置额外负载均衡、存储插件或指标服务。

```bash
k3d cluster create huahuo-agent-local --servers 1 --agents 0 --no-lb \
  --api-port 127.0.0.1:16447 \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --env 'GOMEMLIMIT=448MiB@server:0' \
  --k3s-arg '--disable=traefik,servicelb,local-storage,metrics-server@server:0'
docker build --build-arg MASTRA_BUILD_STUDIO=false -t huahuo-agent:local .
k3d image import huahuo-agent:local --cluster huahuo-agent-local

local_kubeconfig=$(mktemp)
k3d kubeconfig get huahuo-agent-local > "$local_kubeconfig"
kubectl --kubeconfig "$local_kubeconfig" apply -k k8s/overlays/local
kubectl --kubeconfig "$local_kubeconfig" -n huahuo-agent-local rollout status deployment/huahuo-agent --timeout=180s
kubectl --kubeconfig "$local_kubeconfig" -n huahuo-agent-local exec deployment/huahuo-agent \
  -- node /app/release/runtime-check.mjs
KUBECONFIG="$local_kubeconfig" k3d cluster delete huahuo-agent-local
rm -f -- "$local_kubeconfig"
```

本地 overlay 只运行一个 API-only Pod，内存存储，请求 50m CPU 和 192 MiB 内存。无线上 Secret 或数据库，禁用指标和外连。镜像通过本机导入，Pod 不访问镜像仓库。 [k3d 单节点参数](https://k3d.io/stable/usage/commands/k3d_cluster_create/)
