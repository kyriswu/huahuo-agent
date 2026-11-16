const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

const styles = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#171717;--muted:#575757;--line:#d4d4d4;--field:#fff;--focus:#565656;--error:#b91c1c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}::selection{background:#d6d6d6;color:#171717}
header{padding:24px 32px;display:flex;align-items:center;justify-content:space-between;font-size:18px;font-weight:600}main{width:min(360px,calc(100% - 48px));margin:clamp(24px,10vh,100px) auto 48px}h1{margin:0 0 32px;font-size:30px;line-height:1.3;font-weight:600;letter-spacing:-.02em}label.field{display:block;margin:24px 0 8px;font-weight:500}input,button{font:inherit}input:not([type=checkbox]){width:100%;height:48px;min-width:0;padding:0 13px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--fg);caret-color:var(--fg);font-variant-numeric:tabular-nums}input::placeholder{color:var(--muted);opacity:1}.code-row{display:grid;grid-template-columns:minmax(0,1fr) 130px;gap:10px}button{min-height:44px;border:1px solid var(--line);border-radius:8px;padding:0 14px;background:var(--field);color:var(--fg);cursor:pointer;transition:background-color .15s ease-out}button:hover:not(:disabled){background:#ececec}button:disabled{cursor:default;opacity:.5}button.primary{width:100%;height:48px;margin-top:20px;background:var(--fg);border-color:var(--fg);color:var(--bg);font-weight:600}button.primary:hover:not(:disabled){background:#373737}button.link{border:0;min-height:32px;background:none;padding:0;font-size:13px;color:var(--muted)}:focus-visible{outline:2px solid var(--focus);outline-offset:3px}a{color:inherit;text-underline-offset:3px}.consent{display:flex;align-items:flex-start;gap:8px;margin-top:24px;color:var(--muted);font-size:12px;line-height:1.8}.consent input{width:16px;height:16px;flex:0 0 auto;margin:3px 0 0;accent-color:var(--fg)}#error{min-height:24px;margin:12px 0 0;color:var(--error);font-size:13px}#logout[hidden]{display:none}.legal{max-width:760px;width:calc(100% - 48px);margin:32px auto 64px}.legal pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.9}.legal h1{font-size:24px;margin-bottom:24px}
@media(prefers-color-scheme:dark){:root{--bg:#151515;--fg:#f5f5f5;--muted:#b3b3b3;--line:#484848;--field:#202020;--focus:#d4d4d4;--error:#fca5a5}button:hover:not(:disabled){background:#303030}button.primary:hover:not(:disabled){background:#d4d4d4}}
@media(max-width:420px){header{padding:20px 24px}main{margin-top:48px}.code-row{grid-template-columns:minmax(0,1fr) 124px}}
`;

function document(title: string, body: string, nonce: string, script = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 花火</title><style nonce="${nonce}">${styles}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

export function loginPage(nonce: string, publicPath = '/agent'): string {
  return document('登录', `<header><span>花火</span><button id="logout" class="link" type="button" hidden>退出登录</button></header>
<main><h1>登录</h1><form id="login" novalidate>
<label class="field" for="phone">手机号</label><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="请输入手机号" maxlength="16" required>
<label class="field" for="code">验证码</label><div class="code-row"><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="请输入验证码" maxlength="6" required><button id="send" type="button" disabled>获取验证码</button></div>
<label class="consent"><input id="consent" type="checkbox"><span>我已阅读并同意<a href="${publicPath}/studio-auth/legal/agreement" target="_blank" rel="noopener">《用户协议》</a>和<a href="${publicPath}/studio-auth/legal/privacy" target="_blank" rel="noopener">《隐私政策》</a></span></label>
<button class="primary" id="submit" type="submit" disabled>登录</button><p id="error" role="alert" aria-live="polite"></p>
</form><noscript>请启用 JavaScript 后登录。</noscript></main>`, nonce, `
const phone=document.querySelector('#phone'),code=document.querySelector('#code'),consent=document.querySelector('#consent'),send=document.querySelector('#send'),submit=document.querySelector('#submit'),error=document.querySelector('#error'),logout=document.querySelector('#logout');
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
let clientId;try{clientId=localStorage.getItem('huahuo-studio-client-id');if(!clientId){clientId=uuid();localStorage.setItem('huahuo-studio-client-id',clientId);}}catch{clientId=uuid();}
let smsId='',sentPhone='',seconds=0,sending=false,logging=false,sendKey=uuid(),loginKey=uuid();
const validPhone=()=>/^(?:\\+86)?1[3-9]\\d{9}$/.test(phone.value.trim());
function update(){send.disabled=!validPhone()||seconds>0||sending||logging;send.textContent=sending?'发送中…':seconds>0?seconds+' 秒后重发':'获取验证码';submit.disabled=!smsId||sentPhone!==phone.value.trim()||!/^\\d{6}$/.test(code.value)||!consent.checked||logging;submit.textContent=logging?'登录中…':'登录';}
function showFailure(data,status){const k=data?.error?.code||'';error.textContent=status===429?'操作频繁，请稍后重试。':k==='AGREEMENT_REQUIRED'?'请阅读并同意协议后重试。':/SMS.*(?:EXPIRED|INVALID|NOT_FOUND)|OTP|CODE_INVALID/.test(k)?'验证码有误或已过期，请重新获取。':status>=500?'暂时无法连接，请稍后重试。':'登录失败，请检查手机号和验证码后重试。';}
async function post(path,body){const r=await fetch('${publicPath}/studio-auth/'+path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok){showFailure(data,r.status);return null;}return data;}
phone.addEventListener('input',()=>{smsId='';code.value='';sendKey=uuid();loginKey=uuid();error.textContent='';update();});code.addEventListener('input',()=>{code.value=code.value.replace(/\\D/g,'');loginKey=uuid();error.textContent='';update();});consent.addEventListener('change',update);
send.addEventListener('click',async()=>{sending=true;error.textContent='';update();const current=phone.value.trim();try{const data=await post('sms-code',{phone:current,requestId:sendKey});if(data){seconds=data.cooldownSeconds;sendKey=uuid();if(current===phone.value.trim()){smsId=data.smsRequestId;sentPhone=current;loginKey=uuid();code.focus();}}}catch{error.textContent='网络连接失败，请重试。';}finally{sending=false;update();}});
document.querySelector('#login').addEventListener('submit',async e=>{e.preventDefault();if(submit.disabled)return;logging=true;error.textContent='';update();try{const data=await post('login',{phone:phone.value.trim(),smsRequestId:smsId,smsCode:code.value,clientId,agreementAccepted:consent.checked,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,requestId:loginKey});if(data)location.replace('${publicPath}/');}catch{error.textContent='网络连接失败，请重试。';}finally{logging=false;update();}});
logout.addEventListener('click',async()=>{logout.disabled=true;try{if(await post('logout',{}))location.reload();}catch{error.textContent='网络连接失败，请重试。';}finally{logout.disabled=false;}});
fetch('${publicPath}/studio-auth/session',{credentials:'same-origin'}).then(r=>{logout.hidden=!r.ok;}).catch(()=>{});setInterval(()=>{if(seconds>0){seconds--;update();}},1000);update();
`);
}

export function legalPage(nonce: string, title: string, text: string, publicPath = '/agent'): string {
  return document(title, `<header><span>花火</span></header><main class="legal"><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(text)}</pre></main>`, nonce);
}
