import { context, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator, ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, SimpleSpanProcessor, ParentBasedSampler, AlwaysOnSampler, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFields, telemetryIdentity, type TelemetryConfig } from './config.js';
import { SpanType } from '@mastra/core/observability';
import {agentLabel,modelLabel,providerLabel,toolLabel,routeLabel,dependencyLabel,operationLabel} from './labels.js';

const allowedAttributes = new Set([
  'http.request.method', 'http.route', 'http.response.status_code', 'dependency', 'operation', 'outcome', 'error.type',
  'mastra.span.type', 'mastra.entity.id', 'mastra.entity.type', 'mastra.outcome', 'mastra.stop_reason',
  'mastra.metadata.runId', 'mastra.metadata.taskId', 'gen_ai.system', 'gen_ai.provider.name',
  'mastra.metadata.outcome', 'mastra.metadata.stopReason', 'gen_ai.operation.name', 'gen_ai.agent.id', 'gen_ai.tool.name',
  'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens',
]);
const finiteOutcomes=new Set(['success','error','abort','interrupted','suspend','limit','blocked','unknown','http_error','business_error','network_error','timeout','cancelled','response_error','client_abort','connection_error','response_incomplete','redirect','client_error','server_error']);
const finiteReasons=new Set(['max_steps','max_tokens','timeout','runtime_error','model_error','caller_cancelled','signal_received','observer_failed','context_window_exceeded','guardrail','content_filter','approval_required','stop_condition','iteration_hook','delegation_bail','authentication','authorization']);
function exportValue(key:string,value:unknown):string|number|boolean|undefined{
  if(!allowedAttributes.has(key))return undefined;
  if(key==='http.request.method')return typeof value==='string'&&['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(value)?value:'OTHER';
  if(key==='http.route')return routeLabel(value);
  if(key==='dependency')return dependencyLabel(value);
  if(key==='operation')return operationLabel(value);
  if(key==='gen_ai.request.model'||key==='gen_ai.response.model')return modelLabel(value);
  if(key==='gen_ai.system'||key==='gen_ai.provider.name')return providerLabel(value);
  if(key==='gen_ai.agent.id')return agentLabel(value);
  if(key==='gen_ai.tool.name')return toolLabel(value);
  if(key==='mastra.entity.id')return agentLabel(value)!=='other'?agentLabel(value):toolLabel(value);
  if(key==='mastra.span.type')return Object.values(SpanType).includes(value as SpanType)?String(value):'generic';
  if(key==='mastra.entity.type')return typeof value==='string'&&['agent','tool','workflow','processor','scorer'].includes(value)?value:'other';
  if(key==='gen_ai.operation.name')return typeof value==='string'&&['invoke_agent','execute_tool','chat','text_completion','generate_content','embeddings','workflow'].includes(value)?value:'other';
  if(key==='outcome'||key==='mastra.outcome'||key==='mastra.metadata.outcome')return typeof value==='string'&&finiteOutcomes.has(value)?value:'unknown';
  if(key==='mastra.stop_reason'||key==='mastra.metadata.stopReason')return typeof value==='string'&&finiteReasons.has(value)?value:undefined;
  if(key==='mastra.metadata.runId'||key==='mastra.metadata.taskId')return typeof value==='string'&&/^[A-Za-z0-9._:-]{1,96}$/u.test(value)?value:undefined;
  if(key==='error.type')return typeof value==='string'&&['Error','TypeError','AbortError','TimeoutError','ServerRequestError','MastraError'].includes(value)?value:'other';
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
}

/** Final OTLP boundary: even an unexpected framework attribute/event cannot export payloads. */
export class MetadataSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    const sanitized = spans.map(span => {
      const attributes: Attributes = {};
      for (const [key, value] of Object.entries(span.attributes)) {
        const safe=exportValue(key,value);if(safe!==undefined)attributes[key]=safe;
      }
      const nativeType=span.attributes['mastra.span.type'];
      return {
        ...span, spanContext: () => span.spanContext(),
        name: Object.values(SpanType).includes(nativeType as SpanType) ? `mastra.${nativeType}` : attributes['http.route'] ? `HTTP ${attributes['http.request.method']} ${attributes['http.route']}` : attributes.dependency==='huahuo-server' ? `Server ${attributes['http.request.method']} ${attributes.operation}` : 'mastra.operation',
        attributes, events: [], links: span.links.map(link => ({ context: link.context })),
        status: { code: span.status.code },
      } as ReadableSpan;
    });
    try { this.delegate.export(sanitized, callback); }
    catch { callback({ code: ExportResultCode.FAILED, error: new Error('TRACE_EXPORT_FAILED') }); }
  }
  shutdown(): Promise<void> { return this.delegate.shutdown(); }
  forceFlush(): Promise<void> { return this.delegate.forceFlush?.() ?? Promise.resolve(); }
}

export function createTracerProvider(config: TelemetryConfig = telemetryIdentity, testExporter?: SpanExporter) {
  const delegate = testExporter ?? (config.tracesEndpoint ? new OTLPTraceExporter({ url: config.tracesEndpoint, timeoutMillis: 2_000 }) : undefined);
  const processor = delegate ? (testExporter
    ? new SimpleSpanProcessor(new MetadataSpanExporter(delegate))
    : new BatchSpanProcessor(new MetadataSpanExporter(delegate), { maxQueueSize: 512, maxExportBatchSize: 64, scheduledDelayMillis: 1_000, exportTimeoutMillis: 2_000 })) : undefined;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ ...resourceFields(config), 'service.name': config.service, 'service.version': config.version, 'service.instance.id': config.service_instance_id, 'deployment.environment.name': config.env }),
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 128, eventCountLimit: 0, linkCountLimit: 8 },
    spanProcessors: processor ? [processor] : [],
  });
  return provider;
}

export function registerTracerProvider(provider: NodeTracerProvider) {
  const manager = new AsyncLocalStorageContextManager().enable();
  provider.register({ contextManager: manager, propagator: new W3CTraceContextPropagator() });
  return manager;
}

export function activeSpanFields(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active())?.spanContext();
  return span && trace.isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId } : {};
}
