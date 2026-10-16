import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {createDatabaseAdapter} from '../src/libsql-adapter.mjs';
import {runRaexAgent} from '../src/operations.js';
import {canViewPage} from '../public/access.js';

let sqlite,DB,worker;
const cookies={},ids={};
const passwords={admin:'Operations-admin-password-123',other:'Operations-other-password-123',editor:'Operations-editor-password-123',viewer:'Operations-viewer-password-123'};
async function call(path,{role='admin',body,form,headers={},config={}}={}){
  if(cookies[role])headers.Cookie=cookies[role];if(body)headers['Content-Type']='application/json';
  const response=await worker.fetch(new Request('https://operations.example.test'+path,{method:body||form?'POST':'GET',headers,body:form||(body?JSON.stringify(body):undefined)}),{DB,SETUP_CODE:'operations-test-setup',...config});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
  return {response,status:response.status,data,text};
}
before(async()=>{
  sqlite=new DatabaseSync(':memory:');
  const execute=({sql,args=[]})=>{const s=sqlite.prepare(sql),columns=s.columns().map(c=>c.name),rows=s.all(...args);return {columns,rows,rowsAffected:sqlite.prepare('SELECT changes() n').get().n,lastInsertRowid:null};};
  DB=createDatabaseAdapter({async execute(s){return execute(s);},async batch(ss){sqlite.exec('BEGIN IMMEDIATE');try{const r=ss.map(execute);sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}});
  const url=new URL('../src/worker.js',import.meta.url),source=(await readFile(url,'utf8')).replace(/from '([^']+)';/g,(_m,ref)=>`from '${new URL(ref,url).href}'${ref.endsWith('.json')?" with {type:'json'}":''};`);
  worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
  const setup=await call('/api/auth/setup',{role:null,body:{username:'admin',name:'Operations Admin',password:passwords.admin,setup_code:'operations-test-setup'}});
  assert.equal(setup.status,200);cookies.admin=setup.response.headers.get('set-cookie').split(';')[0];
  for(const [username,role]of [['other','admin'],['editor','editor'],['viewer','viewer']]){
    assert.equal((await call('/api/users',{body:{username,name:username,role,password:passwords[username]}})).status,201);
    const logged=await call('/api/auth/login',{role:null,body:{username,password:passwords[username]}});cookies[username]=logged.response.headers.get('set-cookie').split(';')[0];
  }
  for(const row of (await call('/api/users')).data.rows)ids[row.username]=row.id;
});
after(()=>sqlite.close());

test('role navigation and server permissions hide restricted pages and partner action history',async()=>{
  for(const role of ['viewer','editor']){
    assert.equal(canViewPage(role,'logs'),false);
    assert.equal((await call('/api/logs',{role})).status,403);
    assert.equal((await call('/api/password-requests',{role})).status,403);
    assert.deepEqual((await call('/api/partners/detail?tap_code=ARETC',{role})).data.logs,[]);
  }
  for(const page of ['launch','terminate','users','requests'])assert.equal(canViewPage('viewer',page),false);
  for(const page of ['launch','terminate'])assert.equal(canViewPage('editor',page),true);
  assert.equal(canViewPage('admin','logs'),true);
  assert.equal((await call('/api/launch',{role:'viewer',body:{}})).status,403);
  assert.equal((await call('/api/terminate',{role:'viewer',body:{}})).status,403);
});

test('reset requests are generic, deduplicated, visible to all admins and completed atomically once',async()=>{
  const unknown=await call('/api/auth/forgot-password',{role:null,body:{identifier:'missing'}});
  const request=await call('/api/auth/forgot-password',{role:null,body:{identifier:'viewer'}});
  assert.equal(request.status,200);assert.deepEqual(request.data,unknown.data);
  await call('/api/auth/forgot-password',{role:null,body:{identifier:'viewer'}});
  const pending=(await call('/api/password-requests')).data;
  assert.equal(pending.total,1);assert.deepEqual(pending,(await call('/api/password-requests',{role:'other'})).data);
  assert.equal((await call('/api/notifications',{role:'other'})).data.password_requests,1);
  const id=pending.rows[0].id;
  assert.equal((await call(`/api/users/${ids.editor}/reset-password`,{body:{current_password:passwords.admin,new_password:'Wrong-target-password-123',reason:'Wrong target',request_id:id}})).status,409);
  assert.equal((await call(`/api/users/${ids.viewer}/reset-password`,{body:{current_password:'incorrect',new_password:'Unapplied-password-123',reason:'Wrong password',request_id:id}})).status,400);
  const results=await Promise.all(['admin','other'].map(role=>call(`/api/users/${ids.viewer}/reset-password`,{role,body:{current_password:passwords[role],new_password:`${role}-replacement-password-123`,reason:'Verified identity through approved channel',request_id:id}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call('/api/password-requests')).data.total,0);
  const done=(await call('/api/password-requests?status=Done',{role:'other'})).data.rows[0];
  assert.equal(done.status,'Done');assert.ok(done.done_at);assert.ok(['admin','other'].includes(done.done_by));
  assert.equal((await call('/api/notifications',{role:'other'})).data.password_requests,0);
  const winner=results[0].status===200?'admin':'other';
  const login=await call('/api/auth/login',{role:null,body:{username:'viewer',password:`${winner}-replacement-password-123`}});
  assert.equal(login.status,200);cookies.viewer=login.response.headers.get('set-cookie').split(';')[0];
});

function documentForm(version,date,contents='%PDF-1.7\nSynthetic authorized test document'){
  const form=new FormData();for(const [k,v]of Object.entries({tap_code:'ARETC',kind:'IR21',revision:version,source_at:date}))form.set(k,v);
  form.append('attachment',new Blob([contents]),'IR21-test.pdf');return form;
}
let firstDocument;
test('IR documents cover every TAP and retain downloadable versions with per-user notifications',async()=>{
  const initial=await call('/api/raex/documents');assert.equal(initial.data.total,962);assert.equal(initial.data.agent.configured,false);
  for(const role of ['viewer','editor'])assert.equal((await call('/api/raex/upload',{role,form:documentForm('1','2026-01-01')})).status,403);
  const first=await call('/api/raex/upload',{form:documentForm('1','2026-01-01')});assert.equal(first.status,200);assert.equal(first.data.changed,true);firstDocument=first.data.id;
  assert.equal((await call('/api/raex/upload',{form:documentForm('1','2026-01-01')})).data.changed,false);
  assert.equal((await call('/api/raex/upload',{form:documentForm('bad','2025-01-01','%PDF-1.7\nStale version')})).status,409);
  assert.equal((await call('/api/raex/upload',{form:documentForm('bad','2026-01-02','not a PDF')})).status,400);
  assert.equal((await call('/api/raex/upload',{form:documentForm('2','2026-02-01','%PDF-1.7\nUpdated document')})).data.changed,true);
  const list=await call('/api/raex/documents?q=ARETC&kind=IR21',{role:'viewer'});assert.equal(list.data.rows[0].revision,'2');
  assert.equal((await call('/api/raex/history?tap_code=ARETC&kind=IR21',{role:'editor'})).data.rows.length,2);
  assert.equal((await call('/api/raex/download/'+firstDocument,{role:null})).status,401);
  const download=await call('/api/raex/download/'+firstDocument,{role:'viewer'});assert.equal(download.text,'%PDF-1.7\nSynthetic authorized test document');assert.match(download.response.headers.get('content-disposition'),/attachment/);
  assert.equal((await call('/api/raex/documents?missing=1')).data.total,961);
  const notifications=(await call('/api/notifications',{role:'viewer'})).data;assert.equal(notifications.unread,2);
  assert.equal((await call('/api/notifications/read',{role:'viewer',body:{ids:notifications.updates.map(n=>n.id)}})).status,200);
  assert.equal((await call('/api/notifications',{role:'viewer'})).data.unread,0);
  assert.equal((await call('/api/notifications',{role:'editor'})).data.unread,2);
});

test('authorized-feed agent saves updates, resumes its cursor and preserves files on failure',async()=>{
  const config={RAEX_FEED_URL:'https://approved.example.test/documents',RAEX_FEED_TOKEN:'test-feed-token'};
  const record={tap_code:'ARETC',kind:'IR85',revision:'1',source_at:'2026-03-01',filename:'IR85.xml',content_base64:Buffer.from('<?xml version="1.0"?><IR85>synthetic</IR85>').toString('base64')};
  const mock=async(url,init)=>{assert.match(url,/^https:\/\/approved.example.test\/documents/);assert.equal(init.headers.Authorization,'Bearer test-feed-token');return new Response(JSON.stringify({documents:[record],next_cursor:'next-page'}));};
  assert.equal((await runRaexAgent(DB,config,mock)).updated,1);
  assert.equal(sqlite.prepare("SELECT value FROM metadata WHERE key='raex_agent_cursor'").get().value,'next-page');
  assert.equal((await runRaexAgent(DB,config,mock)).updated,0);
  const before=sqlite.prepare('SELECT COUNT(*) n FROM raex_documents').get().n;
  await assert.rejects(()=>runRaexAgent(DB,config,async()=>new Response('secret provider details',{status:403})),/Existing documents were preserved/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM raex_documents').get().n,before);
  assert.equal(sqlite.prepare("SELECT value FROM metadata WHERE key='raex_agent_cursor'").get().value,'next-page');
  assert.ok(!sqlite.prepare("SELECT value FROM metadata WHERE key='raex_agent_status'").get().value.includes('secret'));
  assert.equal((await runRaexAgent(DB,{})).status,'awaiting_access');
  await assert.rejects(()=>runRaexAgent(DB,{...config,RAEX_FEED_URL:'http://localhost'}),/HTTPS/);
});

test('scheduled sync requires its secret, and browser users cannot invoke the agent as viewers',async()=>{
  assert.equal((await call('/api/cron/raex',{role:null,config:{RAEX_FEED_URL:'https://approved.example.test/documents',RAEX_FEED_TOKEN:'private'}})).status,401);
  assert.equal((await call('/api/cron/raex',{role:null,headers:{Authorization:'Bearer correct-secret'},config:{CRON_SECRET:'correct-secret'}})).data.status,'awaiting_access');
  assert.equal((await call('/api/raex/sync',{role:'viewer',body:{}})).status,403);
});
