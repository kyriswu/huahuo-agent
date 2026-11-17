import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { telemetryIdentity, type TelemetryConfig } from './config.js';
export {serverOperation} from './labels.js';
import {agentOperations,normalizedAgentPath} from './labels.js';

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];
export type ClientOutcome = 'success' | 'http_error' | 'business_error' | 'network_error' | 'timeout' | 'cancelled' | 'response_error';
export type AbortReason = 'client_abort' | 'connection_error' | 'response_incomplete';
export class AgentMetrics {
  readonly registry = new Registry();
  readonly httpRequests;
  readonly httpDuration;
  readonly httpAborts;
  readonly httpAbortDuration;
  readonly clientRequests;
  readonly clientDuration;
  readonly runSegments;
  readonly runSegmentDuration;
  readonly runs;
  readonly runDuration;
  readonly modelRequests;
  readonly modelDuration;
  readonly modelTokens;
  readonly modelUsage;
  readonly toolCalls;
  readonly toolDuration;
  readonly firstText;
  readonly inFlight;
  private server?: Server;
  private startPromise?: Promise<void>;

  constructor(readonly config: TelemetryConfig = telemetryIdentity) {
    this.registry.setDefaultLabels({ env: config.env, service: config.service, role: config.role });
    const registers = [this.registry];
    const counter = <T extends string>(name: string, help: string, labelNames: T[]) => new Counter<T>({ name, help, labelNames, registers });
    const histogram = <T extends string>(name: string, help: string, labelNames: T[]) => new Histogram<T>({ name, help, labelNames, registers, buckets });
    new Gauge({ name: 'application_info', help: 'Application identity and supported telemetry capabilities.', labelNames: ['version', 'service_instance_id', 'ttft'], registers })
      .set({ version: config.version, service_instance_id: config.service_instance_id, ttft: 'first_text' }, 1);
    const httpLabels = ['method', 'route', 'status', 'outcome', 'traffic'];
    this.httpRequests = counter('http_requests_total', 'HTTP responses whose complete body was consumed.', httpLabels);
    this.httpDuration = histogram('http_request_duration_seconds', 'HTTP lifetime through complete response body, including SSE.', httpLabels);
    const abortLabels = ['method', 'route', 'traffic', 'reason'];
    this.httpAborts = counter('http_aborted_requests_total', 'HTTP readers ending without a complete response. This does not imply run cancellation.', abortLabels);
    this.httpAbortDuration = histogram('http_aborted_request_duration_seconds', 'HTTP lifetime before incomplete response.', abortLabels);
    const clientLabels = ['dependency', 'operation', 'method', 'status', 'outcome'];
    this.clientRequests = counter('http_client_requests_total', 'Dependency calls through full body and envelope validation; each transport attempt once.', clientLabels);
    this.clientDuration = histogram('http_client_request_duration_seconds', 'Dependency lifetime through complete response validation.', clientLabels);
    this.runSegments = counter('agent_run_segments_total', 'Ended native run execution segments, including suspension and resumption.', ['agent', 'outcome']);
    this.runSegmentDuration = histogram('agent_run_segment_duration_seconds', 'Native execution segment duration, excluding time suspended.', ['agent', 'outcome']);
    this.runs = counter('agent_runs_total', 'Native terminal run outcomes; suspension/interruption are not terminal. Process-local bounded deduplication.', ['agent', 'outcome']);
    this.runDuration = histogram('agent_run_duration_seconds', 'Terminal execution segment duration; not total wall time across resumptions.', ['agent', 'outcome']);
    const modelLabels = ['provider', 'model', 'outcome'];
    this.modelRequests = counter('model_requests_total', 'Ended native MODEL_INFERENCE calls, not generation/step rollups.', modelLabels);
    this.modelDuration = histogram('model_request_duration_seconds', 'Native provider inference duration.', modelLabels);
    this.modelTokens = counter('model_tokens_total', 'Known original provider usage from MODEL_INFERENCE only. Missing usage is not zero.', ['provider', 'model', 'direction']);
    this.modelUsage = counter('model_usage_reports_total', 'Original provider usage availability per inference.', ['provider', 'model', 'availability']);
    this.toolCalls = counter('tool_calls_total', 'Ended native server tool calls; each tool span once.', ['tool', 'outcome']);
    this.toolDuration = histogram('tool_call_duration_seconds', 'Native server tool execution duration.', ['tool', 'outcome']);
    this.firstText = histogram('agent_time_to_first_text_seconds', 'Initial native run start to first nonempty text delta; no sample for nonstream, no text, or resumed segments.', ['agent']);
    this.inFlight = new Gauge({name:'http_requests_in_flight',help:'Active HTTP body readers, including SSE, excluding health and metrics.',registers});
  }

  start(): Promise<void> {
    if (!this.config.metricsEnabled) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
        void this.registry.metrics().then(body => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': this.registry.contentType, 'cache-control': 'no-store' }); res.end(body);
        }, () => { if (!res.destroyed) res.writeHead(503).end(); });
      });
      server.headersTimeout = 5_000; server.requestTimeout = 5_000; server.keepAliveTimeout = 1_000;
      server.maxConnections = 16;
      server.once('error', () => { this.server = undefined; reject(new Error('METRICS_LISTEN_FAILED')); });
      this.server = server;
      server.listen(this.config.metricsPort, this.config.metricsHost, () => resolve());
    });
    return this.startPromise;
  }

  get address() { return this.server?.address(); }
  async close(): Promise<void> {
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

export const agentMetrics = new AgentMetrics();
export function observeSafely(action: () => void): void { try { action(); } catch { /* Telemetry must not change a business result. */ } }
export function httpRoute(path: string): string {
  const p = normalizedAgentPath(path);
  const agent=/^\/api\/agents\/[^/]+\/([^/]+)(?:\/vnext|\/ui|\/vnext\/ui)?$/u.exec(p);
  if(agent&&agentOperations.has(agent[1]))return `/api/agents/:agent/${agent[1]}`;
  if (/^\/api\/agents\/[^/]+\/runs\/[^/]+\/abort$/u.test(p)) return '/api/agents/:agent/runs/:run/abort';
  if (/^\/api\/agents\/[^/]+\/threads\/(abort|subscribe)$/u.test(p)) return p.endsWith('/abort')?'/api/agents/:agent/threads/abort':'/api/agents/:agent/threads/subscribe';
  if (/^\/studio-auth\/(sms-code|login|logout|session)$/u.test(p)) return p;
  if (/^\/api\/auth\/[^/]+$/u.test(p)) return '/api/auth/:operation';
  if (p === '/health' || p === '/api/health') return '/health';
  return '/other';
}
export function httpTraffic(path: string): string {
  const p=normalizedAgentPath(path);
  return /^\/internal(?:\/|$)/u.test(p) ? 'internal' : /^\/admin(?:\/|$)/u.test(p) ? 'admin' : /^\/(?:api|studio-auth)(?:\/|$)/u.test(p) ? 'public' : 'other';
}
export function safeMethod(method: string): string { return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER'; }
