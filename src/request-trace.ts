import type {ContextWithMastra,Middleware} from '@mastra/core/server';
import {context,propagation,trace,SpanKind,SpanStatusCode} from '@opentelemetry/api';
import {currentTraceId,resolveTraceId,withTraceId} from './trace.js';
import {logger} from './logging.js';
import {agentMetrics,httpRoute,httpTraffic,safeMethod,observeSafely,type AgentMetrics,type AbortReason} from './observability/metrics.js';

type RequestContext=Pick<ContextWithMastra,'req'|'header'|'res'>;
/** Observe the existing body as it is pulled. Never independently consume a business/SSE stream. */
export async function traceRequest<T>(c:RequestContext,execute:()=>Promise<T>,metrics:AgentMetrics=agentMetrics):Promise<T>{
 const active=currentTraceId(),id=active??resolveTraceId(c.req.header('x-trace-id'));
 c.header('X-Trace-Id',id);
 if(active)return execute();
 const path=new URL(c.req.url).pathname,method=safeMethod(c.req.method),route=httpRoute(path),traffic=httpTraffic(path);
 const parent=propagation.extract(context.active(),{traceparent:c.req.header('traceparent'),tracestate:c.req.header('tracestate')});
 const span=trace.getTracer('huahuo-agent.http').startSpan(`HTTP ${method} ${route}`,{kind:SpanKind.SERVER,attributes:{'http.request.method':method,'http.route':route}},parent);
 const requestContext=trace.setSpan(parent,span),start=performance.now();
 const tracked=route!=='/health'&&path!=='/metrics';
 if(tracked)observeSafely(()=>metrics.inFlight.inc());
 let done=false;
 const signal=c.req.raw.signal;
 let finish:(status?:number,reason?:AbortReason)=>void;
 const onAbort=()=>finish(undefined,'client_abort');
 finish=(status,reason)=>{
  if(done)return;done=true;signal?.removeEventListener('abort',onAbort);
  if(tracked)observeSafely(()=>metrics.inFlight.dec());
  const seconds=(performance.now()-start)/1000;
  context.with(requestContext,()=>withTraceId(id,()=>observeSafely(()=>{
   if(reason){const labels={method,route,traffic,reason};metrics.httpAborts.inc(labels);metrics.httpAbortDuration.observe(labels,seconds);span.setAttribute('outcome',reason);span.setStatus({code:SpanStatusCode.ERROR});logger.info('http.server.completed',{method,route,traffic,outcome:'aborted',reason,durationMs:seconds*1000});}
   else {const outcome=status!>=500?'server_error':status!>=400?'client_error':status!>=300?'redirect':'success',labels={method,route,traffic,status:String(status),outcome};metrics.httpRequests.inc(labels);metrics.httpDuration.observe(labels,seconds);span.setAttributes({'http.response.status_code':status!,'outcome':outcome});if(status!>=500)span.setStatus({code:SpanStatusCode.ERROR});logger.info('http.server.completed',{method,route,traffic,statusCode:status,outcome,durationMs:seconds*1000});}
  })));
  span.end();
 };
 signal?.addEventListener('abort',onAbort,{once:true});
 return context.with(requestContext,()=>withTraceId(id,async()=>{
  try{
   const result=await execute();
   const response=result instanceof Response?result:c.res;
   if(signal?.aborted){finish(undefined,'client_abort');return result;}
   if(!response.body){finish(response.status);return result;}
   const reader=response.body.getReader();
   const body=new ReadableStream<Uint8Array>({
    async pull(controller){
     try{const chunk=await context.with(requestContext,()=>reader.read());if(chunk.done){finish(response.status);controller.close();reader.releaseLock();}else controller.enqueue(chunk.value);}
     catch(error){finish(undefined,signal?.aborted?'client_abort':'connection_error');controller.error(error);try{reader.releaseLock();}catch{/* Already released. */}}
    },
    async cancel(reason){finish(undefined,signal?.aborted?'client_abort':'response_incomplete');try{await reader.cancel(reason);}finally{reader.releaseLock();}},
   },{highWaterMark:0});
   const observed=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
   if(result instanceof Response)return observed as T;
   c.res=observed;return result;
  }catch(error){finish(undefined,'connection_error');throw error;}
 }));
}
export const traceMiddleware:Middleware=(c,next)=>traceRequest(c,next);
