# 花火 Agent Kubernetes 发布

线上使用阿里云 ACR 和 Kubernetes。手动触发测试发布时，流程先推送镜像到 ACR，再按返回的摘要更新 Deployment。生产复用已验收的同一摘要。代码合并只运行 CI。

## 接入已有集群

1. 确认目标 context、namespace、可调度的 Linux ARM64 节点、镜像仓库与部署端到 Kubernetes API 的网络路径。测试和生产分别使用各自的授权与配置。Namespace 由集群运维创建。
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

首次接入构建机时可选择 `test` 并勾选 `build_only`，只构建和推送镜像，在 Actions 摘要核对 ARM64 和镜像摘要。构建机一次只跑一个发布构建，BuildKit 容器上限为 1.5 核 CPU 和 3 GiB 内存。构建前，Docker 数据目录与源码临时目录所在文件系统各需至少 25 GiB 空闲。若两者在同一块盘，只需同一份 25 GiB 余量。节点同时承载 Kubernetes 工作负载时，在该构建节点所属节点池将构建预算计入节点预留。 [Buildx 资源限制](https://docs.docker.com/build/builders/drivers/docker-container/) · [ACK 节点资源预留](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/resource-reservation-policy)

| GitHub 位置 | 所需配置 |
| --- | --- |
| 仓库变量 | `AGENT_IMAGE_REPOSITORY`（完整 ACR 地址/命名空间/仓库） |
| `test` Environment 变量 | `AGENT_ACR_REGION_ID`（ECS 构建所在地域，当前为 `cn-beijing`）、`AGENT_BUILD_INSTANCE_ID`、`AGENT_BUILD_COMMAND_ID`、`AGENT_BUILD_ROLE_ARN`（账号 `1472289886746775` 的专用构建角色） |
| `test` 和 `production` Environment 变量 | `AGENT_K8S_CONTEXT` 与 `AGENT_K8S_NAMESPACE` |
| `test` 和 `production` Environment Secret | `AGENT_KUBECONFIG`（已授权、有效期内的完整 kubeconfig） |

北京 ACR 专有网络地址为 `huahuoai-docker-hub-registry-vpc.cn-beijing.cr.aliyuncs.com`。将 `AGENT_IMAGE_REPOSITORY` 设置为 `huahuoai-docker-hub-registry-vpc.cn-beijing.cr.aliyuncs.com/<acr-namespace>/<agent-repository>`，用实际的 ACR 命名空间和 Agent 仓库名替换占位符。ACR 命名空间和 Kubernetes namespace 分别配置。

工作流的 `GITHUB_OIDC_PROVIDER_ARN` 固定为账号 `1472289886746775` 内的共享 Provider `github-actions`。

### 云助手构建机

1. 将 `scripts/kubernetes` 中的 `cloud-build-agent-image.sh`、`acr-auth.sh` 和 `build-agent-image.sh` 从审核过的提交安装到构建节点 `/opt/huahuo-agent-build`。目录和文件由 root 管理。构建节点需要 `git`、`curl`、`jq`、`flock`、阿里云 CLI、ARM64 Docker 和 Buildx。专用 CLI 可放在同目录的 `bin/aliyun`。确认节点能访问 GitHub、构建依赖和 ACR VPC 端点。
2. 在同一目录用 root 创建 `config.json`，将 `region`、`ecsInstanceId`、`instanceId`、`imageRepository` 和 `ramRoleName` 分别设为地域、构建 ECS 实例 ID、ACR 企业版实例 ID、完整私有仓库地址和 ECS 实例角色名称。实例角色只需读取指定构建命令的调用记录、查询指定 ACR 仓库和推送权限，以及换取短期 ACR 凭据。实例身份通过 IMDSv2 获取。 [云助手权限](https://www.alibabacloud.com/help/en/ecs/user-guide/use-ram-to-implement-permission-control) · [ECS 实例角色](https://www.alibabacloud.com/help/en/ecs/user-guide/attach-an-instance-ram-role-to-an-ecs-instance) · [ACR RAM 权限](https://www.alibabacloud.com/help/en/acr/user-guide/ram-authorization-information)
3. 注册固定 Shell 命令，启用下列云助手内置变量，执行超时 20 分钟。仅允许受保护的 `main` 使用 GitHub `test` Environment。OIDC 角色绑定 GitHub 发行方、`sts.aliyuncs.com` 受众和 `repo:kyriswu@5120703/huahuo-agent@1427064230:environment:test`。调用和结果读取权限限定为该命令和该实例，调用的 `ecs:CommandRunAs` 固定为 `root`。 [GitHub 环境分支限制](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#deployment-branches-and-tags) · [云助手内置变量](https://www.alibabacloud.com/help/en/ecs/user-guide/use-custom-parameters-in-cloud-assistant-commands)

```bash
exec /usr/bin/env -i /bin/bash -p /opt/huahuo-agent-build/cloud-build-agent-image.sh '{{ACS::InvokeId}}' '{{ACS::CommandId}}'
```

4. GitHub 把准确的提交 SHA 写入调用标签 `source-sha`。构建机读取本次调用的标签，确认它等于当前受保护的 `test` 头，再核对相同 SHA 的成功 push CI。随后从该提交归档源码并原生构建、推送 ARM64 镜像。GitHub 核对回执中的仓库、提交 SHA 和镜像摘要后继续。 [云助手调用查询](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-describeinvocations)

测试与生产的 Pod 只调度到 Linux ARM64 节点，节点需要能访问 ACR VPC 地址以拉取镜像。自动部署要求 GitHub 托管 runner 能通过已有授权路径访问 Kubernetes API。API 仅在私网可达时，可在能访问该 API 的机器使用以下命令部署已验摘要。部署身份需要应用清单、监视 rollout 和执行 Pod 冒烟所需权限。 [ACK kubeconfig](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/kubeconfig-operation-guide/) · [Kubernetes RBAC 实践](https://kubernetes.io/docs/concepts/security/rbac-good-practices/)

```bash
KUBECONFIG=/path/to/approved-kubeconfig \
AGENT_K8S_CONTEXT=approved-context \
AGENT_K8S_NAMESPACE=approved-namespace \
AGENT_IMAGE_REPOSITORY='huahuoai-docker-hub-registry-vpc.cn-beijing.cr.aliyuncs.com/<acr-namespace>/<agent-repository>' \
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

本地 overlay 跟随开发机架构，只运行一个 API-only Pod，内存存储，请求 50m CPU 和 192 MiB 内存。无线上 Secret 或数据库，禁用指标和外连。镜像通过本机导入，Pod 不访问镜像仓库。 [k3d 单节点参数](https://k3d.io/stable/usage/commands/k3d_cluster_create/)
