import {ConsoleLogger, RegisteredLogger} from '@mastra/core/logger';
import {currentTraceId} from './trace.js';
import {activeSpanFields} from './observability/tracing.js';
import {resourceFields} from './observability/config.js';
import {agentLabel, modelLabel, providerLabel, toolLabel, routeLabel, trafficLabel, dependencyLabel, operationLabel} from './observability/labels.js';

function dataFields(value: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) if ('value' in descriptor) result[key] = descriptor.value;
  return result;
}

/** Keep Mastra's logger, levels and child bindings; add request and W3C correlation. */
export function traceLogger(base: ConsoleLogger): ConsoleLogger {
  return new Proxy(base, {get(target, key) {
    if (key === 'child') return (bindings: Parameters<ConsoleLogger['child']>[0]) => traceLogger(target.child(bindings));
    if (key === 'trackException') return (error: Error, metadata?: Record<string, unknown>) => {
      try { target.trackException(error, {...(metadata ? dataFields(metadata) : {}), ...(currentTraceId() ? {traceId: currentTraceId()} : {})}); } catch { /* Logging cannot fail business execution. */ }
    };
    if (key === 'debug' || key === 'info' || key === 'warn' || key === 'error') return (message: string, ...args: unknown[]) => {
      try {
        const traceId = currentTraceId();
        const provided = args.some(arg => arg && typeof arg === 'object' && Object.hasOwn(dataFields(arg), 'trace_id'));
        const fields = provided ? {} : activeSpanFields();
        target[key](message, ...args, ...(traceId || fields.trace_id ? [{...(traceId ? {traceId} : {}), ...fields}] : []));
      } catch { /* Logging cannot fail business execution. */ }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}

const events = new Set(['http.server.completed','http.client.completed','agent.run.ended','observability.ready','observability.failed','exception']);
const outcomes = new Set(['success','aborted','redirect','client_error','server_error','http_error','business_error','network_error','timeout','cancelled','response_error','error','abort','interrupted','suspend','limit','blocked','unknown']);
const errorTypes = new Set(['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError','MastraError','ZodError','ServerRequestError','other']);
const errorCodes = new Set(['EADDRINUSE','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EPIPE','ABORT_ERR','SERVER_TIMEOUT','SERVER_REQUEST_CANCELLED','SERVER_UNAVAILABLE','SERVER_REQUEST_FAILED','SERVER_RESPONSE_INVALID','METRICS_LISTEN_FAILED','EXECUTION_FAILED']);
const levels = ['debug','info','warn','error'] as const;
type Level = typeof levels[number];
const knownFiles = new Set(['index.js','index.mjs','index.ts','http-client.ts','request-trace.ts','logging.ts','trace.ts','mastra.ts','tracing.ts','metrics.ts','first-text.ts','huox.ts','weather-agent.ts','observability.test.ts']);
const nativeStackGetter=Object.getOwnPropertyDescriptor(new Error(),'stack')?.get;

function safeStack(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const frames: string[] = [];
  for (const line of value.slice(0, 16_384).split('\n').slice(1, 17)) {
    // Accept actual V8 frame syntax only. Never retain the first message line,
    // arbitrary text, function names, absolute directories, URLs or query strings.
    const match = /^\s*at (?:[^()\r\n]{0,160} \()?([^()\s?#]+):(\d{1,7}):(\d{1,7})\)?$/u.exec(line);
    if (!match || /https?:|@|%/u.test(match[1])) continue;
    const file = match[1].split('/').at(-1)!;
    const module = knownFiles.has(file) ? file : match[1].startsWith('node:internal/') ? 'node:internal' : 'dependency';
    frames.push(`at ${module}:${match[2]}:${match[3]}`);
    if (frames.length === 6) break;
  }
  return frames;
}
function safeError(error: Error): {type: string; code: string; stack: string[]} {
  const own = dataFields(error);
  let name = own.name;
  if (!name) {
    let prototype = Object.getPrototypeOf(error) as object | null;
    for (let depth = 0; prototype && depth < 4; depth++, prototype = Object.getPrototypeOf(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'name');
      if (descriptor && 'value' in descriptor) {name = descriptor.value; break;}
    }
  }
  const code = typeof own.code === 'string' && errorCodes.has(own.code) ? own.code : typeof own.id === 'string' && errorCodes.has(own.id) ? own.id : 'EXECUTION_FAILED';
  let stack=own.stack;
  const descriptor=Object.getOwnPropertyDescriptor(error,'stack');
  // Node 26 stores even an assigned stack behind its built-in lazy accessor.
  // Invoke only that exact engine accessor; user-defined accessors stay unread.
  const hasAccessor=(key:string)=>{
    let current:object|null=error;
    for(let depth=0;current&&depth<8;depth++,current=Object.getPrototypeOf(current)){
      const property=Object.getOwnPropertyDescriptor(current,key);
      if(property)return !('value'in property);
    }
    return current!==null;
  };
  if(stack===undefined&&nativeStackGetter&&descriptor?.get===nativeStackGetter&&!hasAccessor('name')&&!hasAccessor('message'))stack=nativeStackGetter.call(error);
  return {type: typeof name === 'string' && errorTypes.has(name) ? name : 'other', code, stack: safeStack(stack)};
}
function safeFields(args: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const arg of args) {
    if (!arg || typeof arg !== 'object' || arg instanceof Error) continue;
    for (const [key, value] of Object.entries(dataFields(arg))) {
      if ((key === 'traceId' || key === 'runId' || key === 'taskId') && typeof value === 'string' && /^[A-Za-z0-9._:-]{1,96}$/u.test(value)) result[key] = value;
      else if (key === 'trace_id' && typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value)) result[key] = value;
      else if (key === 'span_id' && typeof value === 'string' && /^[a-f0-9]{16}$/u.test(value)) result[key] = value;
      else if (key === 'outcome' && typeof value === 'string' && outcomes.has(value)) result[key] = value;
      else if (key === 'agent') result[key] = agentLabel(value);
      else if (key === 'provider') result[key] = providerLabel(value);
      else if (key === 'model') result[key] = modelLabel(value);
      else if (key === 'tool') result[key] = toolLabel(value);
      else if (key === 'route') result[key] = routeLabel(value);
      else if (key === 'traffic') result[key] = trafficLabel(value);
      else if (key === 'dependency') result[key] = dependencyLabel(value);
      else if (key === 'operation') result[key] = operationLabel(value);
      else if (key === 'method' && typeof value === 'string' && ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','OTHER'].includes(value)) result[key] = value;
      else if (key === 'reason' && typeof value === 'string' && ['client_abort','connection_error','response_incomplete'].includes(value)) result[key] = value;
      else if ((key === 'statusCode' || key === 'durationMs') && typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
      else if (key === 'statusCode' && value === 'none') result[key] = value;
      else if (key === 'code' && typeof value === 'string' && errorCodes.has(value)) result[key] = value;
      else if (key === 'err' && value && typeof value === 'object') {
        const err = dataFields(value);
        const type = typeof err.type === 'string' && errorTypes.has(err.type) ? err.type : 'other';
        const code = typeof err.code === 'string' && errorCodes.has(err.code) ? err.code : 'EXECUTION_FAILED';
        const stack: string[] = [];
        if (Array.isArray(err.stack)) for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(err.stack))) {
          if ('value' in descriptor && typeof descriptor.value === 'string' && /^at (?:index\.(?:ts|js|mjs)|http-client\.ts|request-trace\.ts|logging\.ts|trace\.ts|mastra\.ts|tracing\.ts|metrics\.ts|first-text\.ts|huox\.ts|weather-agent\.ts|observability\.test\.ts|node:internal|dependency):\d{1,7}:\d{1,7}$/u.test(descriptor.value)) stack.push(descriptor.value);
          if (stack.length === 6) break;
        }
        result.err = {type, code, stack};
      }
    }
  }
  return result;
}

/** Framework free text and arbitrary metadata never enter the fixed JSON schema. */
export class JsonLogger extends ConsoleLogger {
  constructor(private readonly minimum: Level = 'info', private readonly boundComponent?: RegisteredLogger) {super({name:'huahuo-agent',level:minimum});}
  override __attachObservability(): void { /* Native free-text log forwarding stays disabled. */ }
  override child(bindings: Parameters<ConsoleLogger['child']>[0]): ConsoleLogger {
    const value = typeof bindings === 'string' ? bindings : dataFields(bindings).component;
    return new JsonLogger(this.minimum, Object.values(RegisteredLogger).includes(value as RegisteredLogger) ? value as RegisteredLogger : this.boundComponent);
  }
  private write(level: Level, message: string, args: unknown[]): void {
    if (levels.indexOf(level) < levels.indexOf(this.minimum)) return;
    try {
      const fields=safeFields(args);
      let exception:Error|undefined;
      for(const arg of args){
        if(arg instanceof Error){exception=arg;break;}
        if(arg&&typeof arg==='object'){const nested=dataFields(arg).error;if(nested instanceof Error){exception=nested;break;}}
      }
      if(exception&&!fields.err)fields.err=safeError(exception);
      console[level](JSON.stringify({timestamp:new Date().toISOString(),level,event:exception?'exception':events.has(message)?message:'mastra.event',...resourceFields(),...(this.boundComponent?{component:this.boundComponent}:{}),...activeSpanFields(),...fields,...(currentTraceId()?{traceId:currentTraceId()}:{} )}));
    } catch { /* Logging cannot fail business execution. */ }
  }
  override debug(message: string, ...args: unknown[]) {this.write('debug',message,args);}
  override info(message: string, ...args: unknown[]) {this.write('info',message,args);}
  override warn(message: string, ...args: unknown[]) {this.write('warn',message,args);}
  override error(message: string, ...args: unknown[]) {this.write('error',message,args);}
  override trackException(error: Error, metadata?: Record<string, unknown>) {
    try {this.write('error','exception',[metadata,{err:safeError(error)}]);} catch {this.write('error','exception',[{err:{type:'other',code:'EXECUTION_FAILED',stack:[]}}]);}
  }
}
const configuredLevel = process.env.LOG_LEVEL;
export const logger = traceLogger(new JsonLogger(levels.includes(configuredLevel as Level) ? configuredLevel as Level : 'info'));
