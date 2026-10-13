import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
let server,temp,cookie,base='http://127.0.0.1:8798';
const setupCode='test-private-setup-code';
async function call(path,{body,form,token=cookie,method=body||form?'POST':'GET',origin}={}){
  const headers={};if(token)headers.Cookie=token;if(origin)headers.Origin=origin;if(body)headers['Content-Type']='application/json';
  const response=await fetch(base+path,{method,headers,body:form|| (body?JSON.stringify(body):undefined)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
  return {response,status:response.status,data,text};
}
function form(fields,attachment){const f=new FormData();for(const[k,v]of Object.entries(fields))f.set(k,String(v));if(attachment)f.append('attachment',new Blob([attachment]),'CLL-test.txt');return f;}
before(async()=>{
  temp=await mkdtemp(join(tmpdir(),'umniah-db-test-'));
  server=spawn(process.execPath,['scripts/dev-server.mjs'],{env:{...process.env,PORT:'8798',DB_PATH:join(temp,'test.sqlite'),SETUP_CODE:setupCode},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Test server startup timed out')),30000);server.stdout.on('data',chunk=>{if(String(chunk).includes('running at')){clearTimeout(timeout);resolve();}});server.stderr.on('data',chunk=>{if(String(chunk).includes('Error'))console.error(String(chunk));});server.once('exit',code=>{if(code)reject(new Error('Test server exited '+code));});});
});
after(async()=>{server?.kill();await new Promise(resolve=>setTimeout(resolve,500));if(temp)await rm(temp,{recursive:true,force:true});});
test('database workflows, access checks, audit history, documents, and exports',async()=>{
  assert.equal((await call('/api/records',{token:null})).status,401);
  assert.equal((await call('/api/auth/setup',{body:{username:'admin',password:'Admin-password-123',name:'Test Admin',setup_code:'bad'}})).status,403);
  const setup=await call('/api/auth/setup',{body:{username:'admin',password:'Admin-password-123',name:'Test Admin',setup_code:setupCode}});
  assert.equal(setup.status,200);cookie=setup.response.headers.get('set-cookie').split(';')[0];assert.match(setup.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await call('/api/auth/setup',{body:{username:'other',password:'Admin-password-123',name:'Test Admin',setup_code:setupCode}})).status,409);
  const bootstrap=await call('/api/bootstrap');assert.equal(bootstrap.data.stats.total,2193);assert.equal(bootstrap.data.stats.partners,481);assert.equal(bootstrap.data.import_report.duplicate_rows_preserved,2);
  assert.equal((await call('/api/records?service=Camel&direction=Outbound')).data.total,229);
  assert.equal((await call('/api/records?q=ARETC')).data.rows[0].country,'United Arab Emirates');
  const record={tap_code:'TEST1',imsi_prefix:'00101',service:'Camel',direction:'Outbound',reason:'Test launch reason',executor:'Launch Executor'};
  assert.equal((await call('/api/launch',{form:form({...record,reason:'  '})})).status,400);
  const launched=await call('/api/launch',{form:form(record,'CLL original contents ✓')});assert.equal(launched.status,201,launched.text);const id=launched.data.partner.id;
  assert.equal((await call('/api/launch',{form:form(record)})).status,409);
  assert.equal((await call('/api/records?q=TEST1')).data.rows[0].imsi_prefix,'00101');
  const launchLogs=await call('/api/logs?q=TEST1&action=RP%20launch');assert.equal(launchLogs.data.total,1);const log=launchLogs.data.rows[0];assert.equal(log.executor,'Launch Executor');assert.equal(log.actor,'admin');assert.equal(log.reason,record.reason);assert.ok(Math.abs(Date.now()-Date.parse(log.at))<10000);assert.equal(log.attachments.length,1);
  const download=await call('/api/attachments/'+log.attachments[0].id);assert.equal(download.text,'CLL original contents ✓');assert.match(download.response.headers.get('content-disposition'),/attachment/);
  assert.equal((await call('/api/terminate',{form:form({id,reason:'',executor:'Admin'})})).status,400);
  const terminated=await Promise.all([call('/api/terminate',{form:form({id,reason:'Test termination',executor:'Terminate Executor'},'Termination CLL')}),call('/api/terminate',{form:form({id,reason:'Concurrent termination',executor:'Other'})})]);assert.deepEqual(terminated.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call('/api/records?q=TEST1')).data.total,0);assert.equal((await call('/api/records?q=TEST1&status=Terminated')).data.total,1);assert.equal((await call('/api/logs?q=TEST1&action=RP%20termination')).data.total,1);assert.equal((await call('/api/attachments?q=TEST1')).data.rows.length,2);
  const mapping=await call('/api/countries/import',{body:{source:'Authorised RAEX test export',reason:'Test mapping import',executor:'Mapping Executor',rows:[{tap_code:'TEST1',country:'Jordan'}]}});assert.equal(mapping.status,200,mapping.text);
  const mapped=(await call('/api/records?q=TEST1&status=All')).data.rows[0];assert.equal(mapped.country,'Jordan');assert.equal(mapped.verification_status,'raex_export');
  const csv=await call('/api/export?status=All&ids='+id);assert.equal(csv.status,200);assert.equal(csv.text.split('\r\n').length,2);assert.match(csv.text,/TEST1/);assert.match(csv.text,/Terminated/);assert.match(csv.text,/00101/);
  const whole=await call('/api/export?status=All&format=json');assert.equal(whole.data.length,2194);assert.equal((await call('/api/records?status=Active')).data.total,2193);
  assert.equal((await call('/api/users',{body:{username:'viewer',name:'Test Viewer',password:'Viewer-password-123',role:'viewer'}})).status,201);
  const viewer=await call('/api/auth/login',{body:{username:'viewer',password:'Viewer-password-123'},token:null});assert.equal(viewer.status,200);const viewerCookie=viewer.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/launch',{form:form(record),token:viewerCookie})).status,403);assert.equal((await call('/api/users',{token:viewerCookie})).status,403);assert.equal((await call('/api/records',{token:viewerCookie})).status,200);
  assert.equal((await call('/api/launch',{form:form(record),origin:'https://malicious.example'})).status,403);
  const connection=new DatabaseSync(join(temp,'test.sqlite'));assert.throws(()=>connection.prepare("UPDATE logs SET reason='changed' WHERE id=?").run(log.id),/Audit logs cannot be changed/);assert.throws(()=>connection.prepare('DELETE FROM logs WHERE id=?').run(log.id),/Audit logs cannot be deleted/);connection.close();
  const logout=await call('/api/auth/logout',{method:'POST',token:viewerCookie});assert.equal(logout.status,200);assert.equal((await call('/api/records',{token:viewerCookie})).status,401);
});
