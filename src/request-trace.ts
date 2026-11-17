import type {ContextWithMastra,Middleware} from '@mastra/core/server';
import {currentTraceId,resolveTraceId,withTraceId} from './trace.js';
import {logger} from './logging.js';

export async function traceRequest<T>(c:Pick<ContextWithMastra,'req'|'header'|'res'>,execute:()=>Promise<T>):Promise<T>{
 const active=currentTraceId(),id=active??resolveTraceId(c.req.header('x-trace-id'));
 c.header('X-Trace-Id',id);
 if(active)return execute();
 return withTraceId(id,async()=>{
  let status=500;
  try{const result=await execute();status=result instanceof Response?result.status:c.res.status;return result;}
  finally{logger.info('Request completed',{method:c.req.method,status});}
 });
}
export const traceMiddleware:Middleware=(c,next)=>traceRequest(c,next);
