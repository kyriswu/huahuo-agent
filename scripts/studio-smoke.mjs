import { spawn } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// Built artifact test: loopback HTTP, in-memory storage, no model/SMS/DB calls.
const root=fileURLToPath(new URL('../',import.meta.url));
const probe=net.createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port; await new Promise(r=>probe.close(r));
const env={}; for(const key of ['PATH','HOME','TMPDIR','VOLTA_HOME'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{APP_ENV:'test',NODE_ENV:'production',MASTRA_SKIP_DOTENV:'true',MASTRA_TELEMETRY_DISABLED:'1',MASTRA_POSTGRES_PASSWORD:'',HUAHUO_STUDIO_AUTH_ENABLED:'true',HUAHUO_AGENT_PUBLIC_PATH:'/agent',HUAHUO_STUDIO_ORIGIN:`http://127.0.0.1:${port}`,HUAHUO_SERVER_BASE_URL:'http://127.0.0.1:1',MASTRA_STUDIO_PATH:`${root}/.mastra/output/studio`,MASTRA_HOST:'127.0.0.1',PORT:String(port)});
const child=spawn(process.execPath,['.mastra/output/index.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',s=>logs+=s);child.stderr.on('data',s=>logs+=s);
const base=`http://127.0.0.1:${port}`;
const headers={'x-huahuo-user-id':'a0000000-0000-4000-8000-000000000001','x-huahuo-session-id':'c0000000-0000-4000-8000-000000000003','x-huahuo-auth-method':'bearer','x-trace-id':'build-smoke'};
try{
 let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}if(child.exitCode!==null)throw new Error('BUILT_SERVER_EXITED');await new Promise(r=>setTimeout(r,150));}
 assert(ready,'BUILT_SERVER_NOT_READY');
 const request=(path,withIdentity=true)=>fetch(base+path,{headers:withIdentity?headers:{},redirect:'manual',signal:AbortSignal.timeout(4000)});
 assert.equal((await request('/studio-auth/capabilities',false)).status,401);
 const capabilities=await fetch(base+'/studio-auth/capabilities',{headers:{...headers,'x-huahuo-auth-method':'cookie'},redirect:'manual',signal:AbortSignal.timeout(4000)});
 assert.equal(capabilities.status,200);
 assert.deepEqual(await capabilities.json(),{enabled:false,login:null},'GATEWAY_SESSION_NOT_RECOGNIZED_BY_STUDIO');
 assert.equal(capabilities.headers.get('cache-control'),'no-store');
 const nativeCapabilities=await request('/api/auth/capabilities');assert.equal(nativeCapabilities.status,200);
 assert.deepEqual(await (await request('/studio-auth/capabilities')).json(),await nativeCapabilities.json(),'BEARER_CAPABILITIES_CONTRACT_CHANGED');
 assert.equal((await request('/api/agents',false)).status,401);
 assert.equal((await request('/agent/',false)).status,401);
 const logout=await fetch(base+'/studio-auth/logout',{method:'POST',headers,redirect:'manual'});assert.equal(logout.status,404);
 const login=await request('/studio-login',false);assert.equal(login.status,200);assert((await login.text()).includes('/agent/studio-auth/'));
 const page=await request('/agent/');assert.equal(page.status,200);const html=await page.text();
 assert(html.includes('<base href="/agent/"'),'BASE_PATH_MISSING');
 assert(html.includes("window.MASTRA_API_PREFIX = '/agent/api';"),'API_PREFIX_MISSING');
 assert(html.includes("window.MASTRA_AUTO_DETECT_URL = 'true';"),'PUBLIC_ORIGIN_MISSING');
 const js=/<script type="module"[^>]*src="\.\/([^"]+)"/.exec(html)?.[1];assert(js,'STUDIO_ASSET_MISSING');
 assert.equal((await request('/agent/'+js)).status,200);
 const api=await request('/api/agents');assert.equal(api.status,200);
 const agents=await api.json();assert(JSON.stringify(agents).includes('huox'),'AGENT_SCHEMA_UNEXPECTED');
 console.log(JSON.stringify({status:'passed',checks:['built-native-Studio-html','prefixed-assets','public-login-links','gateway-cookie-Studio-login','trusted-native-api','anonymous-api-401'],externalServices:false}));
}catch(error){console.error(error);console.error(logs.slice(-2500));process.exitCode=1;}finally{child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);const t=setTimeout(()=>child.kill('SIGKILL'),5000);t.unref();});}
