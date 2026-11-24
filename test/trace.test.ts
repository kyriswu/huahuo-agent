import {createRequire} from 'node:module';
import {setTimeout as pause} from 'node:timers/promises';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {ConsoleLogger} from '@mastra/core/logger';
import {currentTraceId,withTraceId} from '../src/trace.js';
import {traceMiddleware} from '../src/request-trace.js';
import {traceLogger} from '../src/logging.js';
import {RagClient} from '../src/server/rag-client.js';
import {readTrustedIdentity} from '../src/auth/trusted-identity.js';
import {StudioIdentityClient} from '../src/studio/identity-client.js';
import {createStudioGateway} from '../src/studio/gateway.js';
import {ChatGPTOpenAIGateway} from '../src/mastra/gateways/chatgpt-openai-gateway.js';
import type {Handler,MiddlewareHandler} from '@mastra/core/server';

const require=createRequire(createRequire(import.meta.url).resolve('mastra'));
interface TestApp {
 use(path:string,handler:MiddlewareHandler):void;
 on(method:string,path:string,handler:Handler):void;
 request(path:string,init?:RequestInit):Promise<Response>;
}
const Hono=require('hono').Hono as new()=>TestApp;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('simple Agent request correlation',()=>{
 it('forwards the active trace to model requests without losing authorization',async()=>{
  vi.stubEnv('CLIPROXY_BASE_URL','http://model.test/v1');
  const seen:Headers[]=[];vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(_input,init)=>{
   seen.push(new Headers(init?.headers));return Response.json({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  }));
  const model=new ChatGPTOpenAIGateway().resolveLanguageModel({modelId:'fixture',providerId:'openai',apiKey:'fixture-model-key'});
  await withTraceId('model-original',()=>model.doGenerate({prompt:[{role:'user',content:[{type:'text',text:'fixture'}]}]}));
  expect(seen).toHaveLength(1);expect(seen[0].get('x-trace-id')).toBe('model-original');expect(seen[0].get('authorization')).toBe('Bearer fixture-model-key');
 });
 it('isolates simultaneous calls, echoes the trace and forwards it on ordinary Server calls',async()=>{
  vi.spyOn(console,'info').mockImplementation(()=>undefined);
  const seen:string[]=[];
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(_url,init)=>{seen.push(new Headers(init?.headers).get('x-trace-id')!);return Response.json({success:true,data:{query:'trace',mode:'hybrid',results:[]},traceId:'server-trace'});}));
  const app=new Hono();app.use('*',traceMiddleware as MiddlewareHandler);
  app.on('GET','/test',async c=>{
   await pause(c.req.header('x-trace-id')==='trace-first'?10:1);
   const identity=readTrustedIdentity({'x-huahuo-user-id':'11111111-1111-4111-8111-111111111111','x-huahuo-session-id':'22222222-2222-4222-8222-222222222222','x-huahuo-auth-method':'bearer','x-trace-id':currentTraceId()});
   await new RagClient({baseUrl:'http://server.test',identity}).query({query:'trace'});
   return c.json({traceId:currentTraceId()});
  });
  const results=await Promise.all(['trace-first','trace-second'].map(id=>app.request('/test',{headers:{'x-trace-id':id}})));
  for(let i=0;i<results.length;i++){expect(results[i].headers.get('x-trace-id')).toBe(['trace-first','trace-second'][i]);expect(await results[i].json()).toEqual({traceId:['trace-first','trace-second'][i]});}
  expect(seen.sort()).toEqual(['trace-first','trace-second']);expect(currentTraceId()).toBeUndefined();
  const legacy=await app.request('/test',{headers:{'x-request-id':'obsolete-request-id'}});
  expect(legacy.headers.get('x-trace-id')).not.toBe('obsolete-request-id');
  expect(()=>withTraceId('',()=>undefined)).toThrow('TRACE_ID_INVALID');
 });
 it('keeps trace correlation on Mastra child loggers without replacing their bindings',async()=>{
  const base=new ConsoleLogger({name:'fixture',level:'debug'}),child=base.child({component:'fixture'});
  const childFactory=vi.spyOn(base,'child').mockReturnValue(child),info=vi.spyOn(child,'info').mockImplementation(()=>undefined);
  const logger=traceLogger(base).child({component:'fixture'});
  await withTraceId('logger-original',async()=>{await pause(1);logger.info('fixture');});
  expect(childFactory).toHaveBeenCalledWith({component:'fixture'});expect(info).toHaveBeenCalledWith('fixture',{traceId:'logger-original'});
 });
 it('traces public login routes even when native auth skips global middleware',async()=>{
  vi.spyOn(console,'info').mockImplementation(()=>undefined);
  const seen:string[]=[];
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(_url,init)=>{seen.push(new Headers(init?.headers).get('x-trace-id')!);return Response.json({success:true,data:{smsRequestId:'11111111-1111-4111-8111-111111111111',cooldownSeconds:60},traceId:'server-trace'});}));
  const gateway=createStudioGateway({enabled:true,origin:'http://studio.test',publicPath:'/agent',agreementVersion:'test',privacyVersion:'test'},new StudioIdentityClient({baseUrl:'http://server.test'}));
  const route=gateway.routes.find(value=>value.path==='/studio-auth/sms-code');if(!route||!('handler' in route))throw Error('TEST_ROUTE_MISSING');
  const app=new Hono();app.on('POST',route.path,route.handler as Handler);
  const response=await app.request('http://studio.test/studio-auth/sms-code',{method:'POST',headers:{origin:'http://studio.test','content-type':'application/json','x-trace-id':'login-original'},body:JSON.stringify({phone:'13800000001',requestId:'22222222-2222-4222-8222-222222222222'})});
  expect(response.status).toBe(200);expect(response.headers.get('x-trace-id')).toBe('login-original');expect(seen).toEqual(['login-original']);
 });
});
