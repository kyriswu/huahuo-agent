import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {context as otelContext, propagation} from '@opentelemetry/api';

const context=new AsyncLocalStorage<string>();
export const currentTraceId=()=>context.getStore();
export const validTraceId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9._:-]{6,96}$/.test(value);
export const resolveTraceId=(value?:unknown)=>validTraceId(value)?value:currentTraceId()??randomUUID();
export function withTraceId<T>(id:string,execute:()=>T):T{
 if(!validTraceId(id))throw new Error('TRACE_ID_INVALID');
 return context.run(id,execute);
}
export function traceHeaders(headers?:HeadersInit):Headers{
 const result=new Headers(headers);result.set('X-Trace-Id',resolveTraceId());
 propagation.inject(otelContext.active(),result,{set:(carrier,key,value)=>carrier.set(key,value)});
 return result;
}
