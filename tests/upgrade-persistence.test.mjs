import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDatabaseAdapter} from '../src/libsql-adapter.mjs';

test('upgrade preserves launches, terminations, CLL bytes, logs, accounts and active sessions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'umniah-upgrade-'));
  let sqlite=new DatabaseSync(join(directory,'existing.sqlite'));
  const execute=({sql,args=[]})=>{
    const statement=sqlite.prepare(sql),columns=statement.columns().map(c=>c.name);
    const rows=statement.all(...args);
    return {columns,rows,rowsAffected:sqlite.prepare('SELECT changes() n').get().n,lastInsertRowid:null};
  };
  const DB=createDatabaseAdapter({async execute(s){return execute(s);},async batch(statements){
    sqlite.exec('BEGIN IMMEDIATE');
    try{const results=statements.map(execute);sqlite.exec('COMMIT');return results;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }});
  const url=new URL('../src/worker.js',import.meta.url);
  const source=(await readFile(url,'utf8')).replace(/from '([^']+)';/g,(_match,ref)=>`from '${new URL(ref,url).href}'${ref.endsWith('.json')?" with {type:'json'}":''};`);
  const load=async(text,revision)=>(await import('data:text/javascript;base64,'+Buffer.from(text+'\n// '+revision).toString('base64'))).default;
  // Model the deployed schema before the additive password-recovery tables existed.
  const previousSchema=source.replace(/^.*`CREATE (?:TABLE IF NOT EXISTS (?:password_resets|user_emails)|INDEX IF NOT EXISTS password_reset_user).*\r?\n/gm,'');
  let worker=await load(previousSchema,'before-upgrade'),cookie;
  async function call(path,{body,form}={}){
    const headers={};if(cookie)headers.Cookie=cookie;if(body)headers['Content-Type']='application/json';
    const response=await worker.fetch(new Request('https://upgrade.example.test'+path,{method:body||form?'POST':'GET',headers,body:form||(body?JSON.stringify(body):undefined)}),{DB,SETUP_CODE:'isolated-upgrade-test'});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
    return {response,status:response.status,data,text};
  }
  function launchForm(code){
    const form=new FormData();
    for(const[key,value]of Object.entries({tap_code:code,imsi_prefix:'00101',service:'Camel',direction:'Outbound',reason:'Existing launch to preserve',executor:'Upgrade test'}))form.set(key,value);
    form.append('attachment',new Blob(['Existing CLL bytes ✓']),'existing-cll.txt');return form;
  }
  const tables=['partners','countries','users','sessions','logs','attachments','attachment_chunks','metadata'];
  const snapshot=()=>Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  try{
    const setup=await call('/api/auth/setup',{body:{username:'upgrade-admin',name:'Upgrade Administrator',password:'Upgrade-test-password-123',setup_code:'isolated-upgrade-test'}});
    assert.equal(setup.status,200);cookie=setup.response.headers.get('set-cookie').split(';')[0];
    const active=await call('/api/launch',{form:launchForm('UPG01')});assert.equal(active.status,201);
    const terminated=await call('/api/launch',{form:launchForm('UPG02')});assert.equal(terminated.status,201);
    const form=new FormData();form.set('id',terminated.data.partner.id);form.set('reason','Existing termination');form.set('executor','Upgrade test');
    assert.equal((await call('/api/terminate',{form})).status,200);
    const before=snapshot(),attachment=before.attachments[0].id;
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('password_resets','user_emails')").get().n,0);
    sqlite.close();sqlite=new DatabaseSync(join(directory,'existing.sqlite'));
    worker=await load(source,'after-upgrade');
    assert.equal((await call('/api/auth/status')).data.user.username,'upgrade-admin');
    assert.deepEqual(snapshot(),before,'Schema initialization must leave existing data byte-for-byte unchanged');
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('password_resets','user_emails')").get().n,2);
    const records=await call('/api/records?q=UPG&status=All');assert.equal(records.data.total,2);
    assert.equal(records.data.rows.find(r=>r.id===active.data.partner.id).status,'Active');
    assert.equal(records.data.rows.find(r=>r.id===terminated.data.partner.id).status,'Terminated');
    assert.equal((await call('/api/attachments/'+attachment)).text,'Existing CLL bytes ✓');
    assert.match((await call('/api/export?status=All&ids='+active.data.partner.id)).text,/UPG01/);
    assert.equal((await call('/api/account')).status,200);
  }finally{sqlite.close();await rm(directory,{recursive:true,force:true});}
});
