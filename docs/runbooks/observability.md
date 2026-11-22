# Agent 可观测性

跨仓共同规范由 huahuo-server 仓库的 `docs/observability/contract.md`、`metrics.md` 与 `README.md` 维护；本页说明 Agent 的实际接入和验收边界。

应用使用 Mastra 的原生 Observability 与官方 OtelBridge，和项目的标准 OTel HTTP span 共用同一个 NodeTracerProvider。没有第二套模型调用器、观测持久表、默认平台 exporter 或全局 HTTP/数据库自动插桩。

## 启动与配置

- `METRICS_ENABLED=true`、`METRICS_HOST=127.0.0.1`、`METRICS_PORT=9464`：独立监听器仅提供 `GET /metrics`。容器可显式监听 `0.0.0.0`，宿主映射应限制在回环或管理网络。它不经过业务身份认证，不接入公开反向代理。
- Kubernetes 在线 Pod 监听 `0.0.0.0:9464`，由 NetworkPolicy 限制采集来源。轻量本地 Kubernetes 禁用指标。本地 Compose 默认把指标映射到宿主回环。
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`：空值时没有外部 trace 网络导出；配置完整 HTTP OTLP `/v1/traces` 地址才启用。有界队列 512、批次 64、1 秒调度、2 秒导出超时；不读取任意 `OTEL_RESOURCE_ATTRIBUTES`，不自动采用通用 OTLP endpoint 开启导出。
- `OTEL_SERVICE_VERSION` 默认 `package.json.version`；`OTEL_SERVICE_INSTANCE_ID` 默认进程 UUID，显式非法值拒绝启动。`APP_ENV=production` 归一化为 env=`prod`，development/test 保持原值；service=`huahuo-agent`、role=`agent` 与 version/instance 一同写入 JSON 日志和 OTel resource。
- `LOG_LEVEL=info`，支持 debug/info/warn/error。框架自由文本统一为 `mastra.event`，异常事件 `exception` 保留 err.type、有限安全 code 和最多六条栈帧，只留受控模块名和行列，删除 message 首行、函数名、绝对路径、URL。仅接受 data property 或 Node 内置安全 stack accessor，跳过用户自定义 getter；不输出原始异常消息、请求正文或提供商响应。

主入口显式等待 metrics 监听成功才构造 Mastra，端口冲突以 `METRICS_LISTEN_FAILED` 拒绝启动；没有把 Mastra 会捕获的 exporter.init 当作就绪门禁。Mastra 正常关闭时，先结束/刷新官方桥 span，再关闭独立监听器和 provider，不增加第二个信号处理器。观测写入失败不改变请求、工具或流 part 的业务结果。

## 指标边界

全部项目指标默认只有 `env/service/role` 三个资源标签；version/instance 只在 `application_info`，该信息指标 `ttft="first_text"` 表示支持原生首文本观测。无用户、会话、run/task/trace ID、URL、token 或任意错误文本标签。agent/tool/provider/model 仅采用项目固定或启动时配置的白名单，其他归 `other`；工具和 provider 的已知别名归一化。

| 指标 | 附加标签与含义 |
| --- | --- |
| `http_requests_total` / `http_request_duration_seconds` | method/route/status/outcome/traffic；完整 body 结束才计数，SSE 包含整个连接寿命 |
| `http_aborted_requests_total` / `http_aborted_request_duration_seconds` | method/route/traffic/reason；reason 为 client_abort、connection_error、response_incomplete |
| `http_requests_in_flight` | 无附加标签；活跃 HTTP/body reader（含 SSE），排除 health/metrics；完成或 abort 幂等归还 |
| `http_client_requests_total` / `http_client_request_duration_seconds` | dependency/operation/method/status/outcome；dependency 固定 huahuo-server，operation 为 rag.query、auth.sms_code、auth.login 或 other；消费全部 body 并校验 envelope/schema 后结束。status 无响应头为 none，outcome 区分 success/http_error/business_error/network_error/timeout/cancelled/response_error |
| `agent_run_segments_total` / `agent_run_segment_duration_seconds` | agent/outcome；每个原生执行段，含 suspend/interrupted/unknown |
| `agent_runs_total` / `agent_run_duration_seconds` | agent/outcome；仅 success/error/abort/limit/blocked 终态，时长为末次执行段，不冒充跨恢复总墙钟时长 |
| `model_requests_total` / `model_request_duration_seconds` | provider/model/outcome；仅 MODEL_INFERENCE 层，排除 generation/step 的重复 rollup。计数单位是原生 inference span，SDK 在同一 span 内的 HTTP 重试不另计 |
| `model_tokens_total` | provider/model/direction；仅 inference 原始已知 input/output usage，不使用 HTTP/SSE finish 的累计量或 abort 合成零，不计算费用 |
| `model_usage_reports_total` | provider/model/availability；complete/partial/unknown，缺失不填零；未结束的中止调用没有原始 usage 时为 unknown |
| `tool_calls_total` / `tool_call_duration_seconds` | tool/outcome；仅原生 TOOL_CALL/MCP_TOOL_CALL 执行层 |
| `agent_time_to_first_text_seconds` | agent；初始 native run 开始到第一个非空 text-delta，包含首文本前的工具等待；不是 first chunk，也不是模型单次纯推理 TTFT |

run 和 span 去重仅在本进程内，以 15 分钟/4096 项缓存有界保留；Prometheus 是聚合观测，不是跨重启的审计账本。暂停/中断不当成成功或取消；恢复最终终态按 runId 去重。重连只附着 durable reader 时不重复模型或工具计算。HTTP reader 断开与 run cancellation 分开：断开可以结束 HTTP abort 指标，不能据此推断原生运行停止；run 的 abort 只认原生终态。

HuoX/weather 共用原生 Processor，只检查 part 类型、非空 text-delta 和时间并返回同一个 part，不独立消费 fullStream，不记录或缓存文本、不逐 token 打日志。非流式生成、无文本、已取消或恢复段不造首文本样本；恢复不冒充重新开始的初始 TTFT。

## 追踪与隐私

保留 `X-Trace-Id` 和业务 `traceId`。入站提取 W3C traceparent/tracestate，出站 ServerHttpClient 在 CLIENT span 上注入；真实 trace_id/span_id 与业务相关 ID 分开。官方桥让原生 run/model/tool 与这些 span 具有父子关系；CLIProxy 现有 fetch 包装同样使用标准注入。未对原生提供商 SDK 开启全局网络自动插桩，不能把原生模型 span 当成每次提供商 HTTP 重试的 span。

跨服务日志使用共同字段 `event/statusCode/durationMs`：HTTP 结束固定 `http.server.completed`，中断同一事件且 outcome=`aborted` 并带有限 reason；出站为 `http.client.completed`，原生终态为 `agent.run.ended`。字段维度沿用指标同一白名单，不输出原始 route/host/URL。日志单位为毫秒，Prometheus duration 指标单位为秒。

Mastra span output processor 在 started/updated/ended 三种事件上均原地清理 input/output/preview、requestContext、任意 metadata、工具输入输出和异常详情；仅保留固定身份、原生 outcome 与数值 usage。最终 OTLP exporter 再执行独立属性白名单，移除 events、异常文本、status.message 和 link attributes。JSON 日志同样采用固定事件和字段白名单。正常业务对话原有的 Mastra memory 行为不属于新增观测存储，未添加 storage exporter。

## 本地验证

`pnpm typecheck`、`pnpm test`。`test/observability.test.ts` 使用随机回环端口验证真实 /metrics、端口冲突拒绝、关闭、无 endpoint 不受通用 OTLP ENV 触发、真实假 OTLP receiver 的序列化载荷、W3C HTTP→官方 native bridge→Server client 父子关系、完整 body timeout/cancel、SSE reader 终态与原生运行分离、首文本透传和实际 mock provider/tool/run 链。输入/输出/工具/URL/token canary 不得出现在 OTLP wire payload 或 JSON 日志。测试不访问模型、短信、真实 DB 或真实业务日志；这些证据不等于测试服务器或真实提供商已联调，更不授予发布许可。

部署及采集端接入见 [Kubernetes 发布](standard-release.md)。
