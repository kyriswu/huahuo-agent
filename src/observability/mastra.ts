import { Observability, BaseExporter } from '@mastra/observability';
import { OtelBridge } from '@mastra/otel-bridge';
import { SpanType, TracingEventType, type AnySpan, type AnyExportedSpan, type SpanOutputProcessor, type TracingEvent } from '@mastra/core/observability';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { agentMetrics, observeSafely, type AgentMetrics } from './metrics.js';
import { createTracerProvider, registerTracerProvider } from './tracing.js';
import { type TelemetryConfig, telemetryIdentity } from './config.js';
import { logger } from '../logging.js';
import {agentLabel,modelLabel,providerLabel,toolLabel} from './labels.js';

const outcomes = new Set(['success', 'error', 'abort', 'interrupted', 'suspend', 'limit', 'blocked']);
const stopReasons = new Set(['max_steps','max_tokens','timeout','runtime_error','model_error','caller_cancelled','signal_received','observer_failed','context_window_exceeded','guardrail','content_filter','approval_required','stop_condition','iteration_hook','delegation_bail','authentication','authorization']);
const terminals = new Set(['success', 'error', 'abort', 'limit', 'blocked']);
const safeId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,96}$/u.test(value) ? value : undefined;
const token = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Mutate the live span as required by Mastra; never copy class instances. */
export class MetadataOnlyProcessor implements SpanOutputProcessor {
  name = 'huahuo-metadata-only';
  process(span?: AnySpan): AnySpan | undefined {
    if (!span) return span;
    const attrs = span.attributes as Record<string, unknown>;
    const usage = attrs?.usage as Record<string, unknown> | undefined;
    const kept: Record<string, unknown> = {};
    if ([SpanType.AGENT_RUN,SpanType.MODEL_GENERATION,SpanType.MODEL_STEP,SpanType.MODEL_INFERENCE].includes(span.type)) {
      kept.model = modelLabel(attrs?.model); kept.provider = providerLabel(attrs?.provider);
    }
    if (span.type === SpanType.MODEL_INFERENCE) {
      // Only the original native inference usage, never SSE finish/abort rollups.
      if (usage && span.outcome !== 'abort') kept.usage = { ...(token(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}), ...(token(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}) };
    }
    span.attributes = kept as AnySpan['attributes'];
    span.name = `mastra.${span.type}`;
    span.input = undefined; span.output = undefined;
    span.inputPreview = undefined; span.outputPreview = undefined; span.errorPreview = undefined;
    const runId = safeId(span.metadata?.runId), taskId = safeId(span.metadata?.taskId);
    span.metadata = { ...(runId ? { runId } : {}), ...(taskId ? { taskId } : {}), ...(span.metadata?.resumed===true?{resumed:true}:{}), ...(outcomes.has(span.outcome ?? '') ? {outcome:span.outcome}:{}), ...(stopReasons.has(span.stopReason ?? '')?{stopReason:span.stopReason}:{}) };
    span.requestContext = undefined; span.tags = undefined;
    span.entityId = span.type === SpanType.AGENT_RUN ? agentLabel(span.entityId) : [SpanType.TOOL_CALL, SpanType.MCP_TOOL_CALL].includes(span.type) ? toolLabel(span.entityId) : undefined;
    span.entityName = undefined;
    span.stopReasonContext = undefined;
    if (span.errorInfo) span.errorInfo = { message: 'EXECUTION_FAILED', id: 'EXECUTION_FAILED', domain: 'AGENT', category: 'UNKNOWN' } as AnySpan['errorInfo'];
    return span;
  }
  async shutdown() {}
}

/** Bounded process-local event/run deduplication; not a persistent execution ledger. */
class RecentIds {
  private readonly entries = new Map<string, number>();
  add(id: string): boolean {
    const now = Date.now();
    const previous=this.entries.get(id);
    if(previous!==undefined&&now-previous<900_000)return false;
    for (const [key, time] of this.entries) { if (now - time < 900_000) break; this.entries.delete(key); }
    while(this.entries.size>=4_096)this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, now); return true;
  }
}

export class NativeMetricsExporter extends BaseExporter {
  name = 'huahuo-native-metrics';
  private readonly spans = new RecentIds();
  private readonly runs = new RecentIds();
  constructor(private readonly metrics: AgentMetrics = agentMetrics) { super(); }
  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type !== TracingEventType.SPAN_ENDED) return;
    const span: AnyExportedSpan = event.exportedSpan;
    if (!span.endTime || !this.spans.add(`${span.traceId}:${span.id}`)) return;
    const seconds = Math.max(0, (span.endTime.getTime() - span.startTime.getTime()) / 1_000);
    const outcome = outcomes.has(span.outcome ?? '') ? span.outcome! : 'unknown';
    observeSafely(() => {
      if (span.type === SpanType.AGENT_RUN) {
        const labels = { agent: agentLabel(span.entityId), outcome };
        this.metrics.runSegments.inc(labels); this.metrics.runSegmentDuration.observe(labels, seconds);
        const runId = safeId(span.metadata?.runId);
        if (terminals.has(outcome) && this.runs.add(`${labels.agent}:${runId ?? `${span.traceId}:${span.id}`}`)) {
          this.metrics.runs.inc(labels); this.metrics.runDuration.observe(labels, seconds);
          logger.info('agent.run.ended', { ...labels, ...(runId ? { runId } : {}), trace_id: span.traceId, span_id: span.id, durationMs: seconds*1_000 });
        }
      } else if (span.type === SpanType.MODEL_INFERENCE) {
        const attrs = span.attributes as {provider?: string; model?: string; usage?: {inputTokens?: number; outputTokens?: number}} | undefined;
        const labels = { provider: providerLabel(attrs?.provider), model: modelLabel(attrs?.model) };
        this.metrics.modelRequests.inc({ ...labels, outcome }); this.metrics.modelDuration.observe({ ...labels, outcome }, seconds);
        const usage = attrs?.usage;
        const input = span.outcome !== 'abort' && token(usage?.inputTokens), output = span.outcome !== 'abort' && token(usage?.outputTokens);
        this.metrics.modelUsage.inc({ ...labels, availability: input && output ? 'complete' : input || output ? 'partial' : 'unknown' });
        if (input) this.metrics.modelTokens.inc({ ...labels, direction: 'input' }, usage!.inputTokens!);
        if (output) this.metrics.modelTokens.inc({ ...labels, direction: 'output' }, usage!.outputTokens!);
      } else if (span.type === SpanType.TOOL_CALL || span.type === SpanType.MCP_TOOL_CALL) {
        const labels = { tool: toolLabel(span.entityId), outcome };
        this.metrics.toolCalls.inc(labels); this.metrics.toolDuration.observe(labels, seconds);
      }
    });
  }
}

export function createAgentObservability(options: { config?: TelemetryConfig; metrics?: AgentMetrics; exporter?: SpanExporter; registerGlobal?: boolean } = {}) {
  const config = options.config ?? telemetryIdentity;
  const metrics = options.metrics ?? agentMetrics;
  const provider = createTracerProvider(config, options.exporter);
  const manager = options.registerGlobal === false ? undefined : registerTracerProvider(provider);
  let stopped = false;
  class LifecycleBridge extends OtelBridge {
    override async shutdown() {
      if (stopped) return;
      stopped = true;
      try { await super.shutdown(); } finally {
        await metrics.close(); await provider.shutdown(); manager?.disable();
      }
    }
  }
  const bridge = new LifecycleBridge({ tracerProvider: provider });
  const observability = new Observability({ configs: { default: {
    serviceName: config.service, bridge, exporters: [new NativeMetricsExporter(metrics)],
    spanOutputProcessors: [new MetadataOnlyProcessor()], includeInternalSpans: true,
    excludeSpanTypes: [SpanType.MODEL_CHUNK], requestContextKeys: [], logging: { enabled: false },
  } } });
  return { observability, provider, bridge, metrics, start: () => metrics.start(), shutdown: () => bridge.shutdown() };
}
