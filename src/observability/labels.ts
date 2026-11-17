// Every value comes from startup configuration or this finite dictionary, never request text.
const label = (value: unknown, allowed: ReadonlySet<string>) => typeof value === 'string' && allowed.has(value) ? value : 'other';
const agents = new Set(['huox', 'weather-agent']);
const tools = new Set(['huahuo-rag-query', 'get-weather', 'online-search', 'url-fetch', 'updateWorkingMemory', 'skill_search', 'skill_read', 'skill_load']);
const providers = new Set(['deepseek', 'openai', 'cliproxy']);
const models = new Set([process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash', process.env.OPENAI_MODEL?.trim() || 'gpt-6.1-sol', process.env.CLIPROXY_MODEL?.trim() || 'gpt-6.1-sol'].filter(value => /^[A-Za-z0-9._:-]{1,96}$/u.test(value)));
export const agentLabel = (value: unknown) => label(value, agents);
export const modelLabel = (value: unknown) => label(value, models);
export function providerLabel(value: unknown): string {
  const normalized = typeof value === 'string' ? ({'deepseek.chat':'deepseek','openai.chat':'openai','chatgpt/openai':'cliproxy','chatgpt/openai.chat':'cliproxy','chatgpt-openai':'cliproxy','chatgptOpenAI':'cliproxy'} as Record<string,string>)[value] ?? value : value;
  return label(normalized, providers);
}
export function toolLabel(value: unknown): string {
  const normalized = typeof value === 'string' ? ({huahuoRagQueryTool:'huahuo-rag-query',weatherTool:'get-weather',onlineSearch:'online-search',urlFetch:'url-fetch'} as Record<string,string>)[value] ?? value : value;
  return label(normalized, tools);
}
export const agentOperations=new Set(['stream','generate','resume-stream','observe','recover','stream-until-idle','resume-stream-until-idle','approve-tool-call','decline-tool-call','approve-tool-call-generate','decline-tool-call-generate','send-message','queue-message','signals','queue-signal']);
export const routes = new Set([...Array.from(agentOperations,op=>`/api/agents/:agent/${op}`),'/api/agents/:agent/runs/:run/abort','/api/agents/:agent/threads/abort','/api/agents/:agent/threads/subscribe','/studio-auth/sms-code','/studio-auth/login','/studio-auth/logout','/studio-auth/session','/api/auth/:operation','/health','/other']);
export const routeLabel = (value: unknown) => typeof value === 'string' && routes.has(value) ? value : '/other';
export const trafficLabel = (value: unknown) => label(value, new Set(['public','internal','admin','other']));
export const dependencyLabel = (value: unknown) => label(value, new Set(['huahuo-server','other']));
export const operationLabel = (value: unknown) => label(value, new Set(['rag.query','auth.sms_code','auth.login','other']));
const publicPrefix=(process.env.HUAHUO_AGENT_PUBLIC_PATH||'/agent').replace(/\/$/u,'');
export function normalizedAgentPath(path:string){return publicPrefix&&(path===publicPrefix||path.startsWith(`${publicPrefix}/`))?path.slice(publicPrefix.length)||'/':path;}
export function serverOperation(path: string): string {
  return ({'/internal/v1/rag/query':'rag.query','/api/v1/auth/sms-code':'auth.sms_code','/api/v1/auth/login':'auth.login'} as Record<string,string>)[path] ?? 'other';
}
