import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createRequire} from 'node:module';
import {setTimeout as pause} from 'node:timers/promises';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {context,trace,propagation,SpanKind} from '@opentelemetry/api';
import {InMemorySpanExporter} from '@opentelemetry/sdk-trace-base';
import {SpanType,type AnySpan} from '@mastra/core/observability';
import type {ProcessInputArgs,ProcessOutputStreamArgs} from '@mastra/core/processors';
import type {MiddlewareHandler,Handler} from '@mastra/core/server';
import {AgentMetrics} from '../src/observability/metrics.js';
import {telemetryConfig} from '../src/observability/config.js';
import {createAgentObservability} from '../src/observability/mastra.js';
import {firstTextProcessor} from '../src/observability/first-text.js';
import {JsonLogger} from '../src/logging.js';
import {traceRequest} from '../src/request-trace.js';
import {ServerHttpClient} from '../src/server/http-client.js';
import {withTraceId} from '../src/trace.js';
import {z} from 'zod';
import {Agent} from '@mastra/core/agent';
import {Mastra} from '@mastra/core';
import {InMemoryStore} from '@mastra/core/storage';
import {createTool} from '@mastra/core/tools';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';

const config=()=>({...telemetryConfig({APP_ENV:'test',OTEL_SERVICE_INSTANCE_ID:'test-process'}),metricsPort:0});
const runtimes:ReturnType<typeof createAgentObservability>[]=[];
const servers:Server[]=[];
function runtime(endpoint?:string){
 const c={...config(),...(endpoint?{tracesEndpoint:endpoint}:{})};const metrics=new AgentMetrics(c),exporter=new InMemorySpanExporter();
 const r=createAgentObservability({config:c,metrics,...(endpoint?{}:{exporter})});runtimes.push(r);return {...r,exporter};
}
async function listen(server:Server){servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
const require=createRequire(createRequire(import.meta.url).resolve('mastra'));
const Hono=require('hono').Hono as new()=>{use(path:string,handler:MiddlewareHandler):void;on(method:string,path:string,handler:Handler):void;request(path:string,init?:RequestInit):Promise<Response>};
afterEach(async()=>{
 for(const r of runtimes.splice(0))await r.observability.shutdown();
 for(const s of servers.splice(0))await new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections();});
 trace.disable();context.disable();propagation.disable();vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();
});

describe('application observability',()=>{
 it('normalizes resources and fails explicit invalid version/instance/metrics configuration',()=>{
  expect(telemetryConfig({APP_ENV:'development'}).env).toBe('development');
  expect(telemetryConfig({APP_ENV:'test'}).env).toBe('test');
  expect(telemetryConfig({APP_ENV:'production'}).env).toBe('prod');
  expect(telemetryConfig({APP_ENV:'prod'}).env).toBe('prod');
  expect(telemetryConfig({}).version).toBe('0.1.0');
  expect(()=>telemetryConfig({OTEL_SERVICE_VERSION:'invalid version\n'})).toThrow('OTEL_SERVICE_VERSION_INVALID');
  expect(()=>telemetryConfig({OTEL_SERVICE_INSTANCE_ID:'https://private/instance'})).toThrow('OTEL_SERVICE_INSTANCE_ID_INVALID');
  expect(()=>telemetryConfig({METRICS_PORT:'0'})).toThrow('METRICS_PORT_INVALID');
 });
 it('keeps useful finite log dimensions and safe error frames without invoking getters or leaking content',()=>{
  const lines:string[]=[],canary='PRIVATE_prompt_reply_sql_token_url_314159';
  vi.spyOn(console,'info').mockImplementation(value=>lines.push(String(value)));
  vi.spyOn(console,'error').mockImplementation(value=>lines.push(String(value)));
  let accessed=0;
  const metadata=Object.defineProperty({statusCode:200,durationMs:12,route:'/api/agents/:agent/stream',traffic:'public',dependency:'huahuo-server',operation:'rag.query',provider:'openai.chat',model:'deepseek-v4-flash',tool:'huahuoRagQueryTool',prompt:canary},'body',{get(){accessed++;return canary;},enumerable:true});
  const logger=new JsonLogger();logger.info('http.client.completed',metadata);
  const error=new TypeError(canary);Object.defineProperty(error,'code',{value:'SERVER_TIMEOUT'});
  Object.defineProperty(error,'providerBody',{get(){accessed++;return canary;}});
  error.stack=`TypeError: ${canary}\n    at secretFunction (/private/account/http-client.ts:42:7)\n    at ${canary} (https://secret.test/token?q=${canary}:4:9)\n    at run (node:internal/process/task_queues:105:5)`;
  logger.trackException(error,{body:canary});logger.error(canary,{error});
  expect(accessed).toBe(0);expect(lines.join('')).not.toContain(canary);expect(lines.join('')).not.toContain('/private/account');
  const records=lines.map(line=>JSON.parse(line));
  expect(records[0]).toMatchObject({event:'http.client.completed',statusCode:200,durationMs:12,route:'/api/agents/:agent/stream',traffic:'public',dependency:'huahuo-server',operation:'rag.query',provider:'openai',model:'deepseek-v4-flash',tool:'huahuo-rag-query'});
  expect(records[1]).toMatchObject({event:'exception',err:{type:'TypeError',code:'SERVER_TIMEOUT',stack:['at http-client.ts:42:7','at node:internal:105:5']}});
  expect(records[2].event).toBe('exception');
  const getterError=new Error(canary);Object.defineProperty(getterError,'stack',{get(){accessed++;return canary;}});logger.trackException(getterError);expect(accessed).toBe(0);
 });
 it('serves a separate real loopback registry, closes it, and rejects an occupied listener before readiness',async()=>{
  const r=runtime();await r.start();const addr=r.metrics.address as AddressInfo;
  const response=await fetch(`http://127.0.0.1:${addr.port}/metrics`);expect(response.status).toBe(200);
  const text=await response.text();expect(text).toContain('application_info{');expect(text).toContain('ttft="first_text"');
  expect(text).toContain('env="test"');expect(text).toContain('service="huahuo-agent"');
  expect((await fetch(`http://127.0.0.1:${addr.port}/other`)).status).toBe(404);
  const conflict=new AgentMetrics({...config(),metricsPort:addr.port});await expect(conflict.start()).rejects.toThrow('METRICS_LISTEN_FAILED');await conflict.close();
  await r.shutdown();await expect(fetch(`http://127.0.0.1:${addr.port}/metrics`)).rejects.toThrow();
 });
 it('does not export through generic SDK environment defaults when the explicit traces endpoint is absent',async()=>{
  let requests=0;const endpoint=await listen(createServer((_req,res)=>{requests++;res.end('{}');}));
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT',endpoint);
  const c=config(),r=createAgentObservability({config:c,metrics:new AgentMetrics(c)});runtimes.push(r);
  trace.getTracer('test').startSpan('mastra.operation').end();await r.provider.forceFlush();await pause(10);
  expect(requests).toBe(0);
 });
 it('continues W3C context through the official native bridge to Server client and waits for its body',async()=>{
  const r=runtime(),app=new Hono();let header:Headers|undefined,release:()=>void=()=>undefined;
  const waiting=new Promise<void>(resolve=>release=resolve);
  const client=new ServerHttpClient({baseUrl:'http://server.test',metrics:r.metrics,fetchImpl:async(_url,init)=>{
   header=new Headers(init?.headers);
   return new Response(new ReadableStream({async start(controller){await waiting;controller.enqueue(new TextEncoder().encode(JSON.stringify({success:true,data:{ok:true},traceId:'remote-correlate'})));controller.close();}}),{status:200});
  }});
  app.use('*',((c,next)=>traceRequest(c,next,r.metrics))as MiddlewareHandler);
  app.on('POST','/api/agents/huox/generate',async c=>{
   const native=r.observability.getDefaultInstance()!.startSpan({name:'canary prompt',type:SpanType.AGENT_RUN,entityId:'huox',metadata:{runId:'native-test-run'}});
   await native.executeInContext(async()=>{await client.post('/internal/v1/rag/query',{},z.object({ok:z.boolean()}),{authentication:'none'});});
   native.end({outcome:'success'});return c.json({ok:true});
  });
  const promise=app.request('/api/agents/huox/generate',{method:'POST',headers:{traceparent:'00-11111111111111111111111111111111-2222222222222222-01','x-trace-id':'legacy-correlation'}});
  await vi.waitFor(()=>expect(header).toBeDefined());
  expect(header!.get('x-trace-id')).toBe('legacy-correlation');expect(header!.get('traceparent')).toMatch(/^00-11111111111111111111111111111111-[a-f0-9]{16}-01$/u);
  expect((await r.metrics.clientRequests.get()).values).toHaveLength(0);
  release();const response=await promise;expect(response.headers.get('x-trace-id')).toBe('legacy-correlation');await response.text();
  await r.observability.flush();await r.provider.forceFlush();
  const spans=r.exporter.getFinishedSpans();const incoming=spans.find(s=>s.kind===SpanKind.SERVER)!,native=spans.find(s=>s.name==='mastra.agent_run')!,clientSpan=spans.find(s=>s.kind===SpanKind.CLIENT)!;
  expect(incoming.parentSpanContext?.spanId).toBe('2222222222222222');expect(native.parentSpanContext?.spanId).toBe(incoming.spanContext().spanId);expect(clientSpan.parentSpanContext?.spanId).toBe(native.spanContext().spanId);
  expect(spans.every(s=>s.spanContext().traceId==='11111111111111111111111111111111')).toBe(true);
  expect((await r.metrics.clientRequests.get()).values[0]).toMatchObject({value:1,labels:{operation:'rag.query',dependency:'huahuo-server',outcome:'success'}});
 });
 it('counts SSE only on reader completion and treats reader cancellation separately from run outcomes',async()=>{
  const r=runtime(),app=new Hono();let output:ReadableStreamDefaultController<Uint8Array>|undefined;
  app.use('*',((c,next)=>traceRequest(c,next,r.metrics))as MiddlewareHandler);
  app.on('GET','/api/agents/huox/stream',()=>new Response(new ReadableStream<Uint8Array>({start(c){output=c;}}),{headers:{'content-type':'text/event-stream'}}));
  const response=await app.request('/api/agents/huox/stream'),reader=response.body!.getReader();
  expect((await r.metrics.inFlight.get()).values[0].value).toBe(1);
  expect((await r.metrics.httpRequests.get()).values).toHaveLength(0);
  output!.enqueue(new TextEncoder().encode('data: fixture\n\n'));expect((await reader.read()).done).toBe(false);
  expect((await r.metrics.httpRequests.get()).values).toHaveLength(0);
  output!.close();expect((await reader.read()).done).toBe(true);
  expect((await r.metrics.httpRequests.get()).values[0].value).toBe(1);
  const second=await app.request('/api/agents/huox/stream');await second.body!.cancel();
  expect((await r.metrics.httpAborts.get()).values[0]).toMatchObject({value:1,labels:{reason:'response_incomplete'}});
  expect((await r.metrics.inFlight.get()).values[0].value).toBe(0);
  expect((await r.metrics.runs.get()).values).toHaveLength(0);
 });
 it('separates timeout, explicit cancellation, response parse failure and business failure',async()=>{
  const r=runtime();
  const client=new ServerHttpClient({baseUrl:'http://server.test',metrics:r.metrics,fetchImpl:async(_url,init)=>new Response(new ReadableStream({start(c){init?.signal?.addEventListener('abort',()=>c.error(init.signal!.reason),{once:true});}}),{status:200})});
  await expect(client.post('/internal/v1/rag/query',{},z.unknown(),{authentication:'none',timeoutMs:10})).rejects.toMatchObject({kind:'timeout'});
  const abort=new AbortController();const pending=client.post('/internal/v1/rag/query',{},z.unknown(),{authentication:'none',signal:abort.signal});abort.abort();await expect(pending).rejects.toMatchObject({kind:'cancelled'});
  for(const [body,kind]of [['bad-json','response'],[JSON.stringify({success:false,error:{code:'DENIED'},traceId:'remote-trace'}),'business']]as const){
   const c=new ServerHttpClient({baseUrl:'http://server.test',metrics:r.metrics,fetchImpl:async()=>new Response(body)});await expect(c.post('/internal/v1/rag/query',{},z.unknown(),{authentication:'none'})).rejects.toMatchObject({kind});
  }
  expect((await r.metrics.clientRequests.get()).values.map(v=>v.labels.outcome).sort()).toEqual(['business_error','cancelled','response_error','timeout']);
 });
 it('exports real OTLP payload and JSON logs with metadata only, while counting native usage exactly once',async()=>{
  const payloads:string[]=[];
  const endpoint=await listen(createServer((req,res)=>{let body='';req.on('data',chunk=>body+=String(chunk));req.on('end',()=>{payloads.push(body);res.writeHead(200,{'content-type':'application/json'}).end('{}');});}));
  const r=runtime(`${endpoint}/v1/traces`),logs:string[]=[];vi.spyOn(console,'info').mockImplementation(value=>logs.push(String(value)));
  const canary='PRIVATE_canary_prompt_reply_tool_URL_token_48128';
  vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES',`user.payload=${canary}`);
  r.observability.setLogger({logger:new JsonLogger('debug')});
  const root=r.observability.getDefaultInstance()!.startSpan({name:canary,type:SpanType.AGENT_RUN,entityId:'huox',input:canary,metadata:{runId:'private-run-fixture',userPayload:canary}});
  const model=root.createChildSpan({name:canary,type:SpanType.MODEL_INFERENCE,attributes:{model:'deepseek-v4-flash',provider:'deepseek',usage:{inputTokens:10,outputTokens:5}},input:canary});
  model.update({output:{text:canary},metadata:{prompt:canary}});model.end({outcome:'success',output:{text:canary}});
  root.createChildSpan({name:canary,type:SpanType.MODEL_GENERATION,attributes:{model:'deepseek-v4-flash',provider:'deepseek',usage:{inputTokens:1000,outputTokens:1000}},input:{messages:[]}}).end({outcome:'success',output:{text:canary}});
  root.createChildSpan({name:canary,type:SpanType.MODEL_INFERENCE,attributes:{model:'deepseek-v4-flash',provider:'deepseek'}}).end({outcome:'abort'});
  root.createChildSpan({name:canary,type:SpanType.TOOL_CALL,entityId:'huahuo-rag-query',input:{secret:canary}}).end({outcome:'error',output:canary});
  root.end({outcome:'success',output:{text:canary}});
  await withTraceId('log-correlate',async()=>new JsonLogger().info(canary,{prompt:canary,url:canary,token:canary}));
  await r.observability.flush();await r.provider.forceFlush();
  expect(payloads.length).toBeGreaterThan(0);const wire=payloads.join('');expect(wire).not.toContain(canary);expect(logs.join('')).not.toContain(canary);
  const parsed=JSON.parse(payloads[0]);expect(parsed.resourceSpans[0].resource.attributes.some((v:{key:string})=>v.key==='service_instance_id')).toBe(true);
  const spans=parsed.resourceSpans.flatMap((rs:{scopeSpans:{spans:unknown[]}[]})=>rs.scopeSpans.flatMap(s=>s.spans));
  expect(spans.length).toBeGreaterThanOrEqual(5);
  const tokens=(await r.metrics.modelTokens.get()).values;expect(tokens.map(v=>v.value).sort((a,b)=>a-b)).toEqual([5,10]);
  expect((await r.metrics.modelUsage.get()).values.map(v=>(v.labels as Record<string,unknown>).availability).sort()).toEqual(['complete','unknown']);
  expect((await r.metrics.runs.get()).values[0].value).toBe(1);
 });
 it('observes only the first nonempty text delta, never tool/start chunks, and isolates concurrent requests',async()=>{
  const r=runtime(),processor=firstTextProcessor('huox',r.metrics);
  const root={type:SpanType.AGENT_RUN,startTime:new Date(Date.now()-100),metadata:{}}as AnySpan;
  const stateA:Record<string,unknown>={},stateB:Record<string,unknown>={};
  const input={state:stateA,tracingContext:{currentSpan:root},messageList:{fixture:true}}as unknown as ProcessInputArgs;
  expect(processor.processInput(input)).toBe(input.messageList);
  for(const state of [stateA,stateB]){
   for(const part of [{type:'start',payload:{}},{type:'tool-call',payload:{toolName:'fixture'}},{type:'text-delta',payload:{text:''}},{type:'text-delta',payload:{text:'private fixture'}},{type:'text-delta',payload:{text:'second'}}]){
    const args={part,state,tracingContext:{currentSpan:root}}as unknown as ProcessOutputStreamArgs;
    expect(await processor.processOutputStream(args)).toBe(part);
   }
  }
  expect((await r.metrics.firstText.get()).values.find(v=>v.metricName?.endsWith('_count'))?.value).toBe(2);
  const before=await r.metrics.firstText.get();
  await processor.processOutputStream({part:{type:'text-delta',payload:{text:'resume'}},state:{},tracingContext:{currentSpan:{...root,metadata:{resumed:true}}}}as unknown as ProcessOutputStreamArgs);
  await processor.processOutputStream({part:{type:'text-delta',payload:{text:'cancel'}},state:{},tracingContext:{currentSpan:root},abortSignal:AbortSignal.abort()}as unknown as ProcessOutputStreamArgs);
  expect(await r.metrics.firstText.get()).toEqual(before);
  vi.spyOn(r.metrics.firstText,'observe').mockImplementation(()=>{throw new Error('fixture observation failed');});
  const part={type:'text-delta',payload:{text:'same object'}};expect(await processor.processOutputStream({part,state:{},tracingContext:{currentSpan:root}}as unknown as ProcessOutputStreamArgs)).toBe(part);
 });
 it('collects real native model/tool/run spans and first text through a mock provider tool loop without changing output',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('UNEXPECTED_NETWORK_IN_MOCK_TEST');}));
  const r=runtime(),processor=firstTextProcessor('huox',r.metrics);let calls=0;
  const model=createOpenAICompatible({name:'openai',baseURL:'http://model.test/v1',apiKey:'fixture',fetch:async(_url,init)=>{
   const request=JSON.parse(String(init?.body))as {stream:boolean};calls++;
   const base={id:'fixture',created:1,model:'deepseek-v4-flash',object:'chat.completion.chunk'};
   const delta=calls===1?{role:'assistant',content:'prefix ',tool_calls:[{index:0,id:'fixture-tool',type:'function',function:{name:'huahuoRagQueryTool',arguments:'{}'}}]}:{role:'assistant',content:'private answer'};
   expect(request.stream).toBe(true);
   return new Response(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:calls===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
  }}).chatModel('deepseek-v4-flash');
  const client=new ServerHttpClient({baseUrl:'http://server.test',metrics:r.metrics,fetchImpl:async()=>Response.json({success:true,data:{ok:true},traceId:'fixture-server'})});
  const tool=createTool({id:'huahuo-rag-query',description:'Fixture only',inputSchema:z.object({}),execute:async()=>client.post('/internal/v1/rag/query',{},z.object({ok:z.boolean()}),{authentication:'none'})});
  const agent=new Agent({id:'huox',name:'fixture',instructions:'fixture',model,inputProcessors:[processor],outputProcessors:[processor],tools:{huahuoRagQueryTool:tool}});
  const mastra=new Mastra({agents:{agent},observability:r.observability,storage:new InMemoryStore({id:'observability-fixture'}),logger:new JsonLogger()});
  try{
   const stream=await agent.stream('private prompt',{maxSteps:3,modelSettings:{maxRetries:0}});
   const types:string[]=[];let textDeltas=0;for await(const part of stream.fullStream){types.push(part.type);if(part.type==='text-delta')textDeltas++;}
   expect(await stream.text).toBe('private answer');expect(types).toContain('tool-call');expect(textDeltas).toBe(2);expect(calls).toBe(2);
   await r.observability.flush();await r.provider.forceFlush();
   expect((await r.metrics.modelRequests.get()).values.reduce((sum,v)=>sum+v.value,0)).toBe(2);
   expect((await r.metrics.modelTokens.get()).values.map(v=>v.value).sort((a,b)=>a-b)).toEqual([10,20]);
   expect((await r.metrics.toolCalls.get()).values[0]).toMatchObject({value:1,labels:{tool:'huahuo-rag-query'}});
   expect((await r.metrics.runs.get()).values[0]).toMatchObject({value:1,labels:{agent:'huox',outcome:'success'}});
   expect((await r.metrics.firstText.get()).values.find(v=>v.metricName?.endsWith('_count'))?.value).toBe(1);
   const spans=r.exporter.getFinishedSpans(),toolSpan=spans.find(s=>s.name==='mastra.tool_call')!,clientSpan=spans.find(s=>s.name==='Server POST rag.query')!;
   expect(clientSpan.parentSpanContext?.spanId).toBe(toolSpan.spanContext().spanId);
   expect(JSON.stringify(spans.map(s=>({name:s.name,attributes:s.attributes,events:s.events,status:s.status})))).not.toContain('private');
  }finally{await mastra.shutdown();}
 });
});
