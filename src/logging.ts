import {ConsoleLogger} from '@mastra/core/logger';
import {currentTraceId} from './trace.js';

/** Keep Mastra's logger, levels and child bindings; add only our request correlation. */
export function traceLogger(base:ConsoleLogger):ConsoleLogger{
 return new Proxy(base,{get(target,key){
  if(key==='child')return (bindings:Parameters<ConsoleLogger['child']>[0])=>traceLogger(target.child(bindings));
  if(key==='trackException')return (error:Error,metadata?:Record<string,unknown>)=>target.trackException(error,{...metadata,...(currentTraceId()?{traceId:currentTraceId()}:{})});
  if(key==='debug'||key==='info'||key==='warn'||key==='error')return (message:string,...args:unknown[])=>{
   const traceId=currentTraceId();target[key](message,...args,...(traceId?[{traceId}]:[]));
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}
export const logger=traceLogger(new ConsoleLogger({name:'huahuo-agent',level:'info'}));
