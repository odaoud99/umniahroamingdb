import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {recoveryMailConfigured,sendPasswordResetEmail} from '../src/recovery-mail.js';

let worker,sqlite,adminCookie,memberId,memberCookie;
let failMail=false;
const mails=[],background=[];
const originalFetch=globalThis.fetch;
const env={SETUP_CODE:'password-test-setup',APP_ORIGIN:'https://roaming.example.com',M365_TENANT_ID:'test-tenant',M365_CLIENT_ID:'test-client',M365_CLIENT_SECRET:'test-only-secret',M365_SENDER:'roaming@example.com'};
const adminPassword='Administrator-password-123';
const memberPassword='Member-initial-password-123';
class Statement{
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Statement(this.sql,args);}
  async first(){return sqlite.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}
  async run(){const result=sqlite.prepare(this.sql).run(...this.args);return {meta:{changes:Number(result.changes)}};}
}
const DB={prepare:sql=>new Statement(sql),async batch(statements){
  sqlite.exec('BEGIN IMMEDIATE');
  try{const rows=statements.map(s=>({results:sqlite.prepare(s.sql).all(...s.args),meta:{changes:Number(sqlite.prepare('SELECT changes() n').get().n)}}));sqlite.exec('COMMIT');return rows;}
  catch(error){sqlite.exec('ROLLBACK');throw error;}
}};
const cookie=result=>result.response.headers.get('set-cookie')?.split(';')[0];
async function call(path,{body,token=adminCookie,method=body?'POST':'GET',config=env,origin,urlOrigin='https://roaming.example.com'}={}){
  const headers={};if(token)headers.Cookie=token;if(body)headers['Content-Type']='application/json';if(origin)headers.Origin=origin;
  const response=await worker.fetch(new Request(urlOrigin+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})}),{...config,DB},{waitUntil:promise=>background.push(promise)});
  return {response,status:response.status,data:await response.json()};
}
async function login(username,password){return call('/api/auth/login',{body:{username,password},token:null});}
async function delivery(){await Promise.all(background.splice(0));}
function lastToken(){return mails.at(-1).message.body.content.match(/#reset-password=([a-f0-9]{64})/)[1];}
before(async()=>{
  // Load the browser-compatible Worker with native JSON imports; do not race the HTTP suite's dist build.
  const workerUrl=new URL('../src/worker.js',import.meta.url);
  const source=(await readFile(workerUrl,'utf8')).replace(/from '([^']+)';/g,(_match,ref)=>`from '${new URL(ref,workerUrl).href}'${ref.endsWith('.json')?" with {type:'json'}":''};`);
  worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
  sqlite=new DatabaseSync(':memory:');
  globalThis.fetch=async(url,init)=>{
    if(String(url).startsWith('https://login.microsoftonline.com/'))return new Response(JSON.stringify({access_token:'mock-token'}),{headers:{'Content-Type':'application/json'}});
    assert.ok(String(url).startsWith('https://graph.microsoft.com/v1.0/users/roaming%40example.com/sendMail'));
    assert.equal(init.headers.Authorization,'Bearer mock-token');
    if(failMail)return new Response('Unavailable',{status:503});
    mails.push(JSON.parse(init.body));return new Response(null,{status:202});
  };
  const setup=await call('/api/auth/setup',{body:{username:'admin',name:'Test Admin',password:adminPassword,email:'admin@example.com',setup_code:env.SETUP_CODE},token:null});
  assert.equal(setup.status,200);adminCookie=cookie(setup);
  assert.equal((await call('/api/users',{body:{username:'member',name:'Test Member',password:memberPassword,email:'member@example.com',role:'editor'}})).status,201);
  memberId=(await call('/api/users')).data.rows.find(u=>u.username==='member').id;
  memberCookie=cookie(await login('member',memberPassword));
});
after(async()=>{await delivery();globalThis.fetch=originalFetch;sqlite?.close();});

test('own password changes require the current password and revoke every existing session',async()=>{
  const second=cookie(await login('member',memberPassword));
  assert.equal((await call('/api/auth/change-password',{token:memberCookie,body:{current_password:'wrong',new_password:'Member-updated-password-123'}})).status,400);
  assert.equal((await call('/api/auth/change-password',{token:memberCookie,body:{current_password:memberPassword,new_password:'short'}})).status,400);
  const changed=await call('/api/auth/change-password',{token:memberCookie,body:{current_password:memberPassword,new_password:'Member-updated-password-123'}});
  assert.equal(changed.status,200);assert.match(changed.response.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await call('/api/account',{token:memberCookie})).status,401);
  assert.equal((await call('/api/account',{token:second})).status,401);
  assert.equal((await login('member',memberPassword)).status,401);
  memberCookie=cookie(await login('member','Member-updated-password-123'));assert.ok(memberCookie);
});

test('only an administrator can reset another account, with confirmation and an audit reason',async()=>{
  const path=`/api/users/${memberId}/reset-password`;
  assert.equal((await call(path,{token:memberCookie,body:{current_password:'Member-updated-password-123',new_password:'Admin-replaced-password-123',reason:'Not permitted'}})).status,403);
  assert.equal((await call(path,{body:{current_password:'wrong',new_password:'Admin-replaced-password-123',reason:'Recovery requested'}})).status,400);
  assert.equal((await call(path,{body:{current_password:adminPassword,new_password:'Admin-replaced-password-123',reason:''}})).status,400);
  assert.equal((await call(path,{body:{current_password:adminPassword,new_password:'Admin-replaced-password-123',reason:'Verified staff recovery request'}})).status,200);
  assert.equal((await call('/api/account',{token:memberCookie})).status,401);
  assert.equal((await call('/api/account')).status,200);
  memberCookie=cookie(await login('member','Admin-replaced-password-123'));assert.ok(memberCookie);
  const logs=sqlite.prepare("SELECT * FROM logs WHERE action='Password changed' ORDER BY at DESC").all();
  assert.ok(logs.some(l=>l.actor==='admin'&&l.reason==='Verified staff recovery request'));
  assert.ok(logs.every(l=>!JSON.stringify(l).includes('Admin-replaced-password-123')&&!JSON.stringify(l).includes('password_hash')));
});

test('forgotten passwords queue an administrator request; optional admin email goes only to the stored address',async()=>{
  const unknown=await call('/api/auth/forgot-password',{token:null,body:{identifier:'unknown-user'}});
  const known=await call('/api/auth/forgot-password',{token:null,urlOrigin:'https://untrusted-host.example',body:{identifier:'member',email:'attacker@example.com'}});
  assert.equal(unknown.status,200);assert.deepEqual(unknown.data,known.data);assert.ok(!known.data.reset_path);
  await delivery();assert.equal(mails.length,0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM password_requests WHERE user_id=? AND status='Pending'").get(memberId).n,1);
  await call('/api/auth/forgot-password',{token:null,body:{identifier:'member'}});
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM password_requests WHERE user_id=? AND status='Pending'").get(memberId).n,1);
  assert.equal((await call('/api/password-requests',{token:memberCookie})).status,403);
  assert.equal((await call(`/api/users/${memberId}/reset-email`,{body:{current_password:adminPassword,reason:'Administrator requested optional email'}})).status,200);
  await delivery();assert.equal(mails.length,1);
  assert.equal(mails[0].message.toRecipients[0].emailAddress.address,'member@example.com');
  assert.match(mails[0].message.body.content,/https:\/\/roaming\.example\.com\/#reset-password=/);
  assert.ok(!mails[0].message.body.content.includes('untrusted-host'));
  const token=lastToken(),stored=sqlite.prepare('SELECT * FROM password_resets WHERE user_id=?').get(memberId);
  assert.notEqual(stored.token_hash,token);assert.equal(stored.token_hash.length,64);
  assert.ok(Date.parse(stored.expires_at)-Date.now()<=30*60000);
  assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM logs').all()).includes(token));
  const result=await call('/api/auth/reset-password',{token:null,body:{token,new_password:'Email-reset-password-123'}});
  assert.equal(result.status,200);assert.equal((await call('/api/account',{token:memberCookie})).status,401);
  assert.equal((await call('/api/auth/reset-password',{token:null,body:{token,new_password:'Second-reset-password-123'}})).status,400);
  memberCookie=cookie(await login('member','Email-reset-password-123'));assert.ok(memberCookie);
});

test('expired links are rejected and a reset token is consumed once under concurrent requests',async()=>{
  const path=`/api/users/${memberId}/reset-email`;
  assert.equal((await call(path,{body:{current_password:adminPassword,reason:'New recovery email'}})).status,200);await delivery();
  const expired=lastToken();sqlite.prepare("UPDATE password_resets SET expires_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal((await call('/api/auth/reset-password',{token:null,body:{token:expired,new_password:'Expired-link-password-123'}})).status,400);
  await call(path,{body:{current_password:adminPassword,reason:'Verified recovery follow-up'}});await delivery();
  const token=lastToken();
  const results=await Promise.all(['Concurrent-first-password-123','Concurrent-second-password-123'].map(new_password=>call('/api/auth/reset-password',{token:null,body:{token,new_password}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  const password=results[0].status===200?'Concurrent-first-password-123':'Concurrent-second-password-123';
  memberCookie=cookie(await login('member',password));assert.ok(memberCookie);
});

test('email updates require password confirmation, enforce uniqueness, and invalidate pending links',async()=>{
  assert.equal((await call(`/api/users/${memberId}/email`,{token:memberCookie,body:{email:'other@example.com',current_password:'wrong'}})).status,403);
  assert.equal((await call(`/api/users/${memberId}/email`,{body:{email:'member-new@example.com',current_password:'wrong'}})).status,400);
  await call(`/api/users/${memberId}/reset-email`,{body:{current_password:adminPassword,reason:'Recovery test'}});await delivery();const oldToken=lastToken();
  assert.equal((await call(`/api/users/${memberId}/email`,{body:{email:'member-new@example.com',current_password:adminPassword}})).status,200);
  assert.equal((await call('/api/auth/reset-password',{token:null,body:{token:oldToken,new_password:'Revoked-link-password-123'}})).status,400);
  assert.equal((await call(`/api/users/${memberId}/email`,{body:{email:'admin@example.com',current_password:adminPassword}})).status,409);
  assert.equal((await call('/api/account',{token:memberCookie})).data.email,'member-new@example.com');
});

test('failed delivery revokes its token; administrator recovery works without mail; unsafe origins are rejected',async()=>{
  failMail=true;
  assert.equal((await call(`/api/users/${memberId}/reset-email`,{body:{current_password:adminPassword,reason:'Delivery failure test'}})).status,200);
  await delivery();failMail=false;
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM password_resets WHERE user_id=?').get(memberId).n,0);
  assert.ok(sqlite.prepare("SELECT * FROM logs WHERE action='Password reset email failed'").get());
  assert.equal((await call('/api/auth/forgot-password',{config:{SETUP_CODE:env.SETUP_CODE},token:null,body:{identifier:'member'}})).status,200);
  assert.equal((await call('/api/auth/change-password',{token:memberCookie,origin:'https://malicious.example',body:{current_password:'wrong',new_password:'Attacker-password-123'}})).status,403);
  assert.equal((await call('/api/auth/reset-password',{token:null,body:{token:'invalid',new_password:'Attacker-password-123'}})).status,400);
});

test('Microsoft 365 adapter validates configuration and never surfaces provider secrets in errors',async()=>{
  assert.equal(recoveryMailConfigured(env),true);
  for(const APP_ORIGIN of ['http://example.com','https://attacker@example.com','https://example.com/path','not-a-url'])assert.equal(recoveryMailConfigured({...env,APP_ORIGIN}),false);
  await assert.rejects(()=>sendPasswordResetEmail(env,'member@example.com','a'.repeat(64),async()=>new Response('sensitive provider details',{status:401})),/Microsoft 365 email authorization failed/);
});

test('password confirmation attempts are limited without changing the password',async()=>{
  for(let i=0;i<10;i++)assert.equal((await call('/api/auth/change-password',{token:memberCookie,body:{current_password:'incorrect',new_password:'Never-applied-password-123'}})).status,400);
  assert.equal((await call('/api/auth/change-password',{token:memberCookie,body:{current_password:'incorrect',new_password:'Never-applied-password-123'}})).status,429);
});

test('administrators can reset other administrators and their own password',async()=>{
  const created=await call('/api/users',{body:{username:'second-admin',name:'Another Admin',role:'admin',password:'Another-admin-password-123'}});assert.equal(created.status,201);
  const id=(await call('/api/users')).data.rows.find(u=>u.username==='second-admin').id;
  const otherSession=cookie(await login('second-admin','Another-admin-password-123'));
  assert.equal((await call(`/api/users/${id}/reset-password`,{body:{current_password:adminPassword,new_password:'Another-admin-replaced-123',reason:'Verified administrator recovery'}})).status,200);
  assert.equal((await call('/api/account',{token:otherSession})).status,401);
  assert.equal((await login('second-admin','Another-admin-replaced-123')).status,200);
  const own=(await call('/api/users')).data.rows.find(u=>u.username==='admin').id;
  const changed=await call(`/api/users/${own}/reset-password`,{body:{current_password:adminPassword,new_password:'Administrator-replaced-123',reason:'Own password renewal'}});
  assert.equal(changed.status,200);assert.equal(changed.data.signed_out,true);
  assert.match(changed.response.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await call('/api/account')).status,401);
  assert.equal((await login('admin','Administrator-replaced-123')).status,200);
});
