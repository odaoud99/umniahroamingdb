import seed from '../data/seed.json';
import countries from '../data/tap_countries.json';
import report from '../data/import-report.json';
import isoCountries from '../data/iso_countries.json';
import {recoveryMailConfigured,sendPasswordResetEmail} from './recovery-mail.js';
import {initializeOperations,handleOperations,queuePasswordRequest,runRaexAgent} from './operations.js';

const SERVICES = ['GSM','GPRS','LTE','Camel'];
const DIRECTIONS = ['Inbound','Outbound'];
const MAX_FILE = 4 * 1024 * 1024;
const encoder = new TextEncoder();
let initialized;
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const json = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
const hex = buffer => [...new Uint8Array(buffer)].map(b=>b.toString(16).padStart(2,'0')).join('');
async function digest(text){return hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));}
async function passwordHash(password,salt){
  const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256));
}
const equal = (a,b) => {let n=a.length^b.length; for(let i=0;i<Math.max(a.length,b.length);i++)n|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return n===0;};

async function initialize(db){
  if(!initialized)initialized=(async()=>{
    const schema = [
      `CREATE TABLE IF NOT EXISTS partners(id TEXT PRIMARY KEY,tap_code TEXT NOT NULL,imsi_prefix TEXT NOT NULL,service TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Active',source_sheet TEXT,source_row INTEGER,created_at TEXT NOT NULL,terminated_at TEXT)`,
      `CREATE INDEX IF NOT EXISTS partner_tap ON partners(tap_code)`,
      `CREATE TABLE IF NOT EXISTS countries(tap_code TEXT PRIMARY KEY,country TEXT,source TEXT,verification_status TEXT,country_note TEXT)`,
      `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS password_resets(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT,consume_id TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS password_reset_user ON password_resets(user_id)`,
      `CREATE TABLE IF NOT EXISTS user_emails(user_id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS logs(id TEXT PRIMARY KEY,action TEXT NOT NULL,partner_id TEXT,tap_code TEXT,reason TEXT NOT NULL,executor TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,snapshot TEXT NOT NULL)`,
      `CREATE TRIGGER IF NOT EXISTS immutable_log_update BEFORE UPDATE ON logs BEGIN SELECT RAISE(ABORT,'Audit logs cannot be changed'); END`,
      `CREATE TRIGGER IF NOT EXISTS immutable_log_delete BEFORE DELETE ON logs BEGIN SELECT RAISE(ABORT,'Audit logs cannot be deleted'); END`,
      `CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,log_id TEXT NOT NULL,tap_code TEXT,filename TEXT NOT NULL,size INTEGER NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS attachment_chunks(attachment_id TEXT NOT NULL,position INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(attachment_id,position))`,
      `CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)`
    ];
    await db.batch(schema.map(sql=>db.prepare(sql)));
    await initializeOperations(db);
    const imported=await db.prepare(`SELECT value FROM metadata WHERE key='imported'`).first();
    if(!imported){
      const at=now();
      const statements=[];
      for(let i=0;i<seed.length;i+=250)statements.push(db.prepare(`INSERT OR IGNORE INTO partners(id,tap_code,imsi_prefix,service,direction,source_sheet,source_row,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.tap_code'),json_extract(value,'$.imsi_prefix'),json_extract(value,'$.service'),json_extract(value,'$.direction'),json_extract(value,'$.source_sheet'),json_extract(value,'$.source_row'),? FROM json_each(?)`).bind(at,JSON.stringify(seed.slice(i,i+250))));
      for(let i=0;i<countries.length;i+=250)statements.push(db.prepare(`INSERT OR IGNORE INTO countries SELECT json_extract(value,'$.tap_code'),json_extract(value,'$.country'),json_extract(value,'$.source'),json_extract(value,'$.verification_status'),json_extract(value,'$.country_note') FROM json_each(?)`).bind(JSON.stringify(countries.slice(i,i+250))));
      await db.batch(statements);
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO logs VALUES(?,?,?,?,?,?,?,?,?)`).bind('initial-import','Workbook import',null,null,`Imported ${report.rows} original rows from ${report.source}. Source SHA256 ${report.sha256}`,'System import','System',at,JSON.stringify(report)),
        db.prepare(`INSERT OR IGNORE INTO metadata VALUES('imported',?)`).bind(at)
      ]);
    }
  })().catch(e=>{initialized=undefined;throw e;});
  await initialized;
}
function csvCell(value){let v=String(value??'');if(/^[\s]*[=+@-]/.test(v))v="'"+v;return '"'+v.replaceAll('"','""')+'"';}
export function toCSV(rows,headers){return '\uFEFF'+[headers,...rows.map(r=>headers.map(h=>r[h]))].map(row=>row.map(csvCell).join(',')).join('\r\n');}
function criteria(params){
  const clauses=[],values=[];
  const q=(params.get('q')||'').trim();
  if(q){clauses.push(`(p.tap_code LIKE ? ESCAPE '\\' OR p.imsi_prefix LIKE ? ESCAPE '\\' OR COALESCE(c.country,'') LIKE ? ESCAPE '\\')`);const term='%'+q.replace(/[\\%_]/g,'\\$&')+'%';values.push(term,term,term);}
  for(const field of ['service','direction','status'])if(params.get(field)&&!(field==='status'&&params.get(field)==='All')){clauses.push(`p.${field}=?`);values.push(params.get(field));}
  if(!params.get('status')){clauses.push(`p.status='Active'`);}
  if(params.get('country')){clauses.push(`COALESCE(c.country,'Unresolved')=?`);values.push(params.get('country'));}
  const ids=params.get('ids');if(ids){const list=ids.split(',').filter(Boolean);if(list.length>5000)fail('Too many selected records');clauses.push(`p.id IN (SELECT value FROM json_each(?))`);values.push(JSON.stringify(list));}
  return {sql:clauses.length?' WHERE '+clauses.join(' AND '):'',values};
}
const recordSelect=`SELECT p.*,COALESCE(c.country,'Unresolved') country,COALESCE(c.verification_status,'unresolved') verification_status,COALESCE(c.source,'') country_source,COALESCE(c.country_note,'') country_note FROM partners p LEFT JOIN countries c ON c.tap_code=p.tap_code`;
async function queryRecords(db,params,paginate=true){
  const filter=criteria(params);
  const count=await db.prepare('SELECT COUNT(*) total FROM partners p LEFT JOIN countries c ON c.tap_code=p.tap_code'+filter.sql).bind(...filter.values).first();
  const limit=Math.max(1,Math.min(100,Number(params.get('limit'))||25)), page=Math.max(1,Math.floor(Number(params.get('page'))||1));
  const sql=recordSelect+filter.sql+' ORDER BY p.tap_code,p.service,p.direction,p.imsi_prefix,p.id'+(paginate?' LIMIT ? OFFSET ?':'');
  const rows=await db.prepare(sql).bind(...filter.values,...(paginate?[limit,(page-1)*limit]:[])).all();
  return {rows:rows.results,total:count.total,page,limit};
}
function required(value,label,max=2000){const text=String(value??'').trim();if(!text||text.length>max)fail(`${label} is required (maximum ${max} characters).`);return text;}
function validatePassword(value){const password=String(value??'');if(password.length<12||password.length>200||!password.trim())fail('Use a password with 12–200 characters.');return password;}
function validateEmail(value){const email=String(value||'').trim().toLowerCase();if(email.length>254||/[\x00-\x1f\x7f]/.test(email)||! /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))fail('Enter a valid recovery email address.');return email;}
function clearSession(response){response.headers.set('Set-Cookie','urdb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return response;}
async function limitAttempts(req,db,purpose,maximum=10){
  const key=await digest(purpose);
  const clock=Date.now(),attempt=await db.prepare('SELECT * FROM login_attempts WHERE key=?').bind(key).first();
  if(attempt&&attempt.reset_at>clock&&attempt.attempts>=maximum)fail('Too many attempts. Try again in 15 minutes.',429);
  await db.prepare(`INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<? THEN ? ELSE reset_at END`).bind(key,clock+900000,clock,clock,clock+900000).run();
  return key;
}
async function confirmPassword(req,db,user,password){
  const attemptKey=await limitAttempts(req,db,'password-confirmation:'+user.id);
  const account=await db.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const value=String(password||'');if(value.length>200)fail('Your current password is incorrect.',400);
  if(!account||!equal(await passwordHash(value,account.salt),account.password_hash))fail('Your current password is incorrect.',400);
  await db.prepare('DELETE FROM login_attempts WHERE key=?').bind(attemptKey).run();
  return account;
}
async function replacePassword(db,target,password,{reason,actor,executor,reset=null,requestId=null,completeRequests=false}){
  const salt=uid(),hash=await passwordHash(password,salt),at=now(),consumeId=uid(),statements=[];
  if(equal(await passwordHash(password,target.salt),target.password_hash))fail('Choose a different password from the current one.');
  if(reset)statements.push(db.prepare(`UPDATE password_resets SET consumed_at=?,consume_id=? WHERE token_hash=? AND user_id=? AND consumed_at IS NULL AND expires_at>? RETURNING user_id`).bind(at,consumeId,reset,target.id,at));
  statements.push(db.prepare(`UPDATE users SET password_hash=?,salt=? WHERE id=? AND password_hash=? AND salt=?${reset?' AND EXISTS(SELECT 1 FROM password_resets WHERE token_hash=? AND consume_id=?)':''}${requestId?" AND EXISTS(SELECT 1 FROM password_requests WHERE id=? AND user_id=users.id AND status='Pending')":''} RETURNING id`).bind(hash,salt,target.id,target.password_hash,target.salt,...(reset?[reset,consumeId]:[]),...(requestId?[requestId]:[])));
  // The fresh salt gates every dependent write; a stale/consumed request cannot revoke sessions or create an audit event.
  const gate='EXISTS(SELECT 1 FROM users WHERE id=? AND salt=?)';
  statements.push(db.prepare(`DELETE FROM sessions WHERE user_id=? AND ${gate}`).bind(target.id,target.id,salt));
  statements.push(db.prepare(`DELETE FROM password_resets WHERE user_id=?${reset?' AND token_hash<>?':''} AND ${gate}`).bind(target.id,...(reset?[reset]:[]),target.id,salt));
  statements.push(db.prepare(`INSERT INTO logs SELECT ?,?,?,?,?,?,?,?,? WHERE ${gate}`).bind(uid(),'Password changed',null,null,reason,executor,actor,at,JSON.stringify({user_id:target.id,username:target.username,method:reset?'single-use reset link':'password confirmation'}),target.id,salt));
  if(completeRequests)statements.push(db.prepare(`UPDATE password_requests SET status='Done',done_at=?,done_by=? WHERE user_id=? AND status='Pending' AND ${gate}`).bind(at,actor,target.id,target.id,salt));
  const results=await db.batch(statements);
  if(!results[reset?1:0].meta.changes)fail(reset?'This reset link is invalid or expired. Ask an administrator for a new link.':requestId?'This request was completed or the account changed. Refresh the request queue.':'The account changed during this request. Please retry.',reset?400:409);
}
function validateRecord(r){
  const tap_code=required(r.tap_code,'TAP code',5).toUpperCase();if(!/^[A-Z0-9]{5}$/.test(tap_code))fail('TAP code must be five letters or digits.');
  const imsi_prefix=required(r.imsi_prefix,'IMSI prefix',15);if(!/^\d{5,15}$/.test(imsi_prefix))fail('IMSI prefix must contain 5–15 digits.');
  if(!SERVICES.includes(r.service)||!DIRECTIONS.includes(r.direction))fail('Select a valid service and direction.');
  return {tap_code,imsi_prefix,service:r.service,direction:r.direction};
}
function validateNote(body){return {reason:required(body.reason,'Reason'),executor:required(body.executor,'Executor',100)};}
async function formBody(req){const form=await req.formData();const body=Object.fromEntries([...form.entries()].filter(([k])=>k!=='attachment'));const files=form.getAll('attachment').filter(f=>typeof f!=='string'&&f.size);if(files.length>3)fail('Maximum three CLL attachments per action.');if(files.reduce((n,f)=>n+f.size,0)>MAX_FILE)fail('Attachments must total 4 MB or smaller.');return {body,files};}
function logStatement(db,{id=uid(),action,partner=null,reason,executor,actor,snapshot={},at=now()}){return db.prepare(`INSERT INTO logs VALUES(?,?,?,?,?,?,?,?,?)`).bind(id,action,partner?.id||null,partner?.tap_code||null,reason,executor,actor,at,JSON.stringify(snapshot));}
async function fileStatements(db,files,logId,tap,at,kind='CLL'){
  const statements=[];
  for(const file of files){
    const id=uid(),filename=file.name.replace(/[\\/\x00-\x1f]/g,'_').slice(0,200)||'attachment';
    statements.push(db.prepare(`INSERT INTO attachments VALUES(?,?,?,?,?,?,?)`).bind(id,logId,tap||null,filename,file.size,kind,at));
    const bytes=new Uint8Array(await file.arrayBuffer());
    for(let i=0,n=0;i<bytes.length;i+=262144,n++){let binary='';for(const b of bytes.subarray(i,i+262144))binary+=String.fromCharCode(b);statements.push(db.prepare(`INSERT INTO attachment_chunks VALUES(?,?,?)`).bind(id,n,btoa(binary)));}
  }
  return statements;
}
async function authenticate(req,db){
  const token=(req.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('urdb_session='))?.slice(13);
  if(!token)return null;
  return db.prepare(`SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).bind(await digest(token),now()).first();
}
const canWrite=user=>{if(user.role==='viewer')fail('Your account has read-only access.',403);};
async function issueRecoveryEmail(db,env,target,{reason,actor,executor},ctx){
  if(!recoveryMailConfigured(env))fail('Microsoft 365 recovery email is not configured. Contact your administrator.',503);
  if(!target.email)fail('Add a recovery email address to this account first.');
  const token=hex(crypto.getRandomValues(new Uint8Array(32))),tokenHash=await digest(token),at=now(),expires=new Date(Date.now()+30*60000).toISOString();
  const gate='EXISTS(SELECT 1 FROM users u JOIN user_emails e ON e.user_id=u.id WHERE u.id=? AND u.password_hash=? AND u.salt=? AND e.email=?)',gateValues=[target.id,target.password_hash,target.salt,target.email];
  const issued=await db.batch([
    db.prepare(`DELETE FROM password_resets WHERE (user_id=? OR expires_at<=?) AND ${gate}`).bind(target.id,at,...gateValues),
    db.prepare(`INSERT INTO password_resets SELECT ?,?,?,NULL,NULL,?,? WHERE ${gate}`).bind(tokenHash,target.id,expires,actor,at,...gateValues),
    db.prepare('INSERT INTO logs SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM password_resets WHERE token_hash=?)').bind(uid(),'Password reset email requested',null,null,reason,executor,actor,at,JSON.stringify({user_id:target.id,username:target.username,expires_at:expires}),tokenHash)
  ]);
  if(!issued[1].meta.changes)return;
  const delivery=(async()=>{
    try{await sendPasswordResetEmail(env,target.email,token);}
    catch{
      await db.batch([
        db.prepare('DELETE FROM password_resets WHERE token_hash=?').bind(tokenHash),
        logStatement(db,{action:'Password reset email failed',reason:'Microsoft 365 could not accept the recovery email. Check sender configuration.',actor:'System',executor:'System',snapshot:{user_id:target.id,username:target.username}})
      ]);
    }
  })();
  if(ctx?.waitUntil)ctx.waitUntil(delivery);else await delivery;
}
async function handleApi(req,env,url,ctx){
  const db=env.DB;if(!db)fail('Database binding DB is missing.',503);
  await initialize(db);
  const path=url.pathname,method=req.method;
  if(!['GET','HEAD'].includes(method)){
    const origin=req.headers.get('Origin');if(origin&&origin!==url.origin)fail('Request origin rejected.',403);
  }
  if(path==='/api/auth/status'){
    const count=await db.prepare('SELECT COUNT(*) n FROM users').first();return json({user:await authenticate(req,db),setup_required:count.n===0,password_reset_email_available:recoveryMailConfigured(env)});
  }
  if(path==='/api/cron/raex'&&method==='GET'){
    if(!env.RAEX_FEED_URL||!env.RAEX_FEED_TOKEN)return json({status:'awaiting_access',message:'An authorized RAEX feed is not configured.'});
    if(!env.CRON_SECRET||!equal(req.headers.get('Authorization')||'','Bearer '+env.CRON_SECRET))fail('Not authorized.',401);
    return json(await runRaexAgent(db,env));
  }
  if(path==='/api/auth/forgot-password'&&method==='POST'){
    const started=Date.now(),b=await req.json(),identifier=required(b.identifier,'Username or email',254).toLowerCase();
    await limitAttempts(req,db,'forgot-account:'+identifier);
    await limitAttempts(req,db,'forgot-network:'+(req.headers.get('CF-Connecting-IP')||'local'),100);
    const target=await db.prepare(`SELECT u.*,e.email FROM users u LEFT JOIN user_emails e ON e.user_id=u.id WHERE u.username=? OR e.email=? LIMIT 1`).bind(identifier,identifier).first();
    if(target)await queuePasswordRequest(db,target.id);
    // Known and unknown identifiers receive the same response; requests are visible to every administrator.
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,300-(Date.now()-started))));
    return json({ok:true,message:'If the account exists, a password-reset request is now available to all administrators. Contact your administrator to verify your identity and arrange your new password.'});
  }
  if(path==='/api/auth/reset-password'&&method==='POST'){
    await limitAttempts(req,db,'password-recovery-network:'+(req.headers.get('CF-Connecting-IP')||'local'),100);
    const b=await req.json(),token=String(b.token||'');
    if(!/^[a-f0-9]{64}$/.test(token))fail('This reset link is invalid or expired. Ask an administrator for a new link.');
    const tokenHash=await digest(token),at=now();
    await limitAttempts(req,db,'password-recovery-token:'+tokenHash);
    const target=await db.prepare(`SELECT u.* FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.consumed_at IS NULL AND r.expires_at>?`).bind(tokenHash,at).first();
    if(!target)fail('This reset link is invalid or expired. Ask an administrator for a new link.');
    await replacePassword(db,target,validatePassword(b.new_password),{reason:'Password reset using an emailed recovery link',actor:'Password recovery',executor:'Password recovery',reset:tokenHash});
    return clearSession(json({ok:true}));
  }
  if((path==='/api/auth/setup'||path==='/api/auth/login')&&method==='POST'){
    const b=await req.json();const username=required(b.username,'Username',80).toLowerCase();
    const attemptKey=await digest(username+'|'+(req.headers.get('CF-Connecting-IP')||'local'));
    const clock=Date.now(),attempt=await db.prepare('SELECT * FROM login_attempts WHERE key=?').bind(attemptKey).first();
    if(attempt&&attempt.reset_at>clock&&attempt.attempts>=10)fail('Too many attempts. Try again in 15 minutes.',429);
    await db.prepare(`INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END,reset_at=CASE WHEN reset_at<? THEN ? ELSE reset_at END`).bind(attemptKey,clock+900000,clock,clock,clock+900000).run();
    let user;
    if(path.endsWith('/setup')){
      if(!env.SETUP_CODE||!equal(String(b.setup_code||''),env.SETUP_CODE))fail('Incorrect setup code.',403);
      const password=validatePassword(b.password);
      const email=b.email?validateEmail(b.email):null;
      const salt=uid(),hash=await passwordHash(password,salt),id=uid(),name=required(b.name,'Name',100);
      const result=await db.prepare(`INSERT INTO users SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM users)`).bind(id,username,name,hash,salt,'admin',now()).run();
      if(!result.meta.changes)fail('An administrator already exists. Sign in instead.',409);
      user={id,username,name,role:'admin'};
      if(email)await db.prepare('INSERT INTO user_emails VALUES(?,?,?)').bind(id,email,now()).run();
    }else{
      user=await db.prepare('SELECT * FROM users WHERE username=?').bind(username).first();
      if(String(b.password||'').length>200)fail('Username or password is incorrect.',401);
      const hash=await passwordHash(String(b.password||''),user?.salt||'dummy-salt');
      if(!user||!equal(hash,user.password_hash))fail('Username or password is incorrect.',401);
    }
    await db.prepare('DELETE FROM login_attempts WHERE key=?').bind(attemptKey).run();
    const token=hex(crypto.getRandomValues(new Uint8Array(32))),expiry=new Date(Date.now()+12*3600000).toISOString();
    await db.prepare('INSERT INTO sessions VALUES(?,?,?)').bind(await digest(token),user.id,expiry).run();
    const response=json({user:{id:user.id,username:user.username,name:user.name,role:user.role}});
    response.headers.set('Set-Cookie',`urdb_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${url.protocol==='https:'?'; Secure':''}`);return response;
  }
  const user=await authenticate(req,db);if(!user)fail('Please sign in.',401);
  const operation=await handleOperations({req,env,db,url,user,confirmPassword,replacePassword});
  if(operation)return operation;
  if(path==='/api/account'&&method==='GET'){
    const email=await db.prepare('SELECT email FROM user_emails WHERE user_id=?').bind(user.id).first();
    return json({user,email:email?.email||'',password_reset_email_available:recoveryMailConfigured(env)});
  }
  const emailUser=path.match(/^\/api\/users\/([^/]+)\/email$/);
  if((path==='/api/account/email'||emailUser)&&method==='POST'){
    if(emailUser&&user.role!=='admin')fail('Administrator access required.',403);
    const b=await req.json();await confirmPassword(req,db,user,b.current_password);
    const id=emailUser?emailUser[1]:user.id,target=await db.prepare('SELECT id,username FROM users WHERE id=?').bind(id).first();
    if(!target)fail('Account not found.',404);
    const email=validateEmail(b.email),at=now();
    try{await db.batch([
      db.prepare('INSERT INTO user_emails VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,updated_at=excluded.updated_at').bind(id,email,at),
      db.prepare('DELETE FROM password_resets WHERE user_id=?').bind(id),
      logStatement(db,{action:'Recovery email changed',reason:'Recovery email updated with password confirmation',actor:user.username,executor:user.name,snapshot:{user_id:id,username:target.username},at})
    ]);}catch(e){if(String(e).includes('UNIQUE'))fail('That email is already linked to another account.',409);throw e;}
    return json({ok:true});
  }
  if(path==='/api/auth/change-password'&&method==='POST'){
    const b=await req.json(),target=await confirmPassword(req,db,user,b.current_password);
    await replacePassword(db,target,validatePassword(b.new_password),{reason:'User changed their own password',actor:user.username,executor:user.name});
    return clearSession(json({ok:true}));
  }
  const resetUser=path.match(/^\/api\/users\/([^/]+)\/(reset-password|reset-email)$/);
  if(resetUser&&method==='POST'){
    if(user.role!=='admin')fail('Administrator access required.',403);
    const b=await req.json();await confirmPassword(req,db,user,b.current_password);
    const target=await db.prepare('SELECT u.*,e.email FROM users u LEFT JOIN user_emails e ON e.user_id=u.id WHERE u.id=?').bind(resetUser[1]).first();
    if(!target)fail('Account not found.',404);
    const reason=required(b.reason,'Reason');
    if(resetUser[2]==='reset-password'){
      const requestId=b.request_id?required(b.request_id,'Request ID',100):null;
      await replacePassword(db,target,validatePassword(b.new_password),{reason,actor:user.username,executor:user.name,requestId,completeRequests:true});
      const response=json({ok:true,signed_out:target.id===user.id});return target.id===user.id?clearSession(response):response;
    }
    await issueRecoveryEmail(db,env,target,{reason,actor:user.username,executor:user.name},ctx);
    return json({ok:true,email_requested:true});
  }
  if(path==='/api/auth/logout'&&method==='POST'){
    const token=(req.headers.get('Cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('urdb_session='))?.slice(13);
    if(token)await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
    const response=json({ok:true});response.headers.set('Set-Cookie','urdb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return response;
  }
  if(path==='/api/bootstrap'){
    const stats=await db.prepare(`SELECT COUNT(*) total,COUNT(DISTINCT tap_code) partners,SUM(direction='Inbound') inbound,SUM(direction='Outbound') outbound FROM partners WHERE status='Active'`).first();
    const byService=await db.prepare(`SELECT service,direction,COUNT(*) count FROM partners WHERE status='Active' GROUP BY service,direction`).all();
    const countryList=await db.prepare(`SELECT DISTINCT COALESCE(c.country,'Unresolved') country FROM countries c JOIN partners p ON p.tap_code=c.tap_code WHERE p.status='Active' ORDER BY country`).all();
    const countryStats=await db.prepare(`SELECT verification_status,COUNT(*) count FROM countries GROUP BY verification_status`).all();
    return json({user,stats,by_service:byService.results,countries:countryList.results.map(r=>r.country),country_stats:countryStats.results,services:SERVICES,directions:DIRECTIONS,import_report:report});
  }
  if(path==='/api/records'&&method==='GET')return json(await queryRecords(db,url.searchParams));
  if(path==='/api/partners/detail'){
    const tap=required(url.searchParams.get('tap_code'),'TAP code',5);
    const records=await db.prepare(recordSelect+' WHERE p.tap_code=? ORDER BY p.service,p.direction').bind(tap).all();
    const logs=user.role==='admin'?await db.prepare('SELECT * FROM logs WHERE tap_code=? ORDER BY at DESC').bind(tap).all():{results:[]};
    return json({records:records.results,logs:logs.results.map(r=>({...r,snapshot:JSON.parse(r.snapshot)}))});
  }
  if(path==='/api/launch'&&method==='POST'){
    canWrite(user);const {body,files}=await formBody(req),record=validateRecord(body),note=validateNote(body);
    const id=uid(),logId=uid(),at=now(),partner={id,...record,status:'Active'};
    const attachments=await fileStatements(db,files,logId,record.tap_code,at);
    const insertion=db.prepare(`INSERT INTO partners(id,tap_code,imsi_prefix,service,direction,created_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM partners WHERE tap_code=? AND imsi_prefix=? AND service=? AND direction=? AND status='Active') RETURNING id`).bind(id,record.tap_code,record.imsi_prefix,record.service,record.direction,at,record.tap_code,record.imsi_prefix,record.service,record.direction);
    // Atomic batch: the guard aborts the entire transaction when the record already exists.
    const guard=db.prepare(`INSERT INTO metadata(key,value) SELECT 'imported','duplicate guard' WHERE NOT EXISTS(SELECT 1 FROM partners WHERE id=?)`).bind(id);
    const prefixCountry=isoCountries[record.tap_code.slice(0,3)]||null;
    const mapping=db.prepare(`INSERT OR IGNORE INTO countries VALUES(?,?,?,?,?)`).bind(record.tap_code,prefixCountry,'https://unstats.un.org/unsd/methodology/m49/',prefixCountry?'inferred_prefix':'unresolved','Country prefix inference; confirm against RAEX.');
    try{await db.batch([insertion,guard,mapping,logStatement(db,{id:logId,action:'RP launch',partner,...note,actor:user.username,snapshot:partner,at}),...attachments]);}catch(e){if(String(e).includes('UNIQUE'))fail('This active TAP / IMSI / service / direction combination already exists.',409);throw e;}
    return json({partner,at},201);
  }
  if(path==='/api/terminate'&&method==='POST'){
    canWrite(user);const {body,files}=await formBody(req),note=validateNote(body),id=required(body.id,'Record',100);
    const partner=await db.prepare('SELECT * FROM partners WHERE id=?').bind(id).first();if(!partner||partner.status!=='Active')fail('The selected record is no longer active.',409);
    const logId=uid(),at=now(),attachments=await fileStatements(db,files,logId,partner.tap_code,at);
    // Guard and update share one transaction so concurrent termination cannot create a second action log.
    const guard=db.prepare(`INSERT INTO metadata(key,value) SELECT 'imported','termination guard' WHERE NOT EXISTS(SELECT 1 FROM partners WHERE id=? AND status='Active')`).bind(id);
    try{await db.batch([guard,db.prepare(`UPDATE partners SET status='Terminated',terminated_at=? WHERE id=? AND status='Active'`).bind(at,id),logStatement(db,{id:logId,action:'RP termination',partner,...note,actor:user.username,snapshot:partner,at}),...attachments]);}catch(e){if(String(e).includes('UNIQUE'))fail('The selected record is no longer active.',409);throw e;}
    return json({ok:true,at});
  }
  if(path==='/api/logs'){
    if(user.role!=='admin')fail('Administrator access required.',403);
    const q='%'+(url.searchParams.get('q')||'')+'%',action=url.searchParams.get('action')||'',from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'';
    const where=` WHERE (COALESCE(l.tap_code,'') LIKE ? OR l.reason LIKE ? OR l.executor LIKE ? OR l.actor LIKE ?) AND (?='' OR l.action=?) AND (?='' OR l.at>=?) AND (?='' OR l.at<?)`;
    const end=to?new Date(new Date(to+'T00:00:00+03:00').getTime()+86400000).toISOString():'';
    const values=[q,q,q,q,action,action,from,from?new Date(from+'T00:00:00+03:00').toISOString():'',to,end];
    const page=Math.max(1,Number(url.searchParams.get('page'))||1);
    const total=await db.prepare('SELECT COUNT(*) total FROM logs l'+where).bind(...values).first();
    const logs=await db.prepare(`SELECT l.*, (SELECT json_group_array(json_object('id',a.id,'filename',a.filename)) FROM attachments a WHERE a.log_id=l.id) attachments FROM logs l`+where+' ORDER BY l.at DESC LIMIT 50 OFFSET ?').bind(...values,(page-1)*50).all();
    return json({rows:logs.results.map(l=>({...l,snapshot:JSON.parse(l.snapshot),attachments:JSON.parse(l.attachments)})),total:total.total,page,limit:50});
  }
  if(path==='/api/attachments'){
    const q='%'+(url.searchParams.get('q')||'')+'%',action=url.searchParams.get('action')||'';
    const rows=await db.prepare(`SELECT a.*,l.action,l.executor,l.actor,l.reason FROM attachments a JOIN logs l ON l.id=a.log_id WHERE a.kind='CLL' AND (COALESCE(a.tap_code,'') LIKE ? OR a.filename LIKE ? OR l.executor LIKE ?) AND (?='' OR l.action=?) ORDER BY a.at DESC`).bind(q,q,q,action,action).all();return json({rows:rows.results});
  }
  if(path.startsWith('/api/attachments/')&&method==='GET'){
    const id=decodeURIComponent(path.slice(17)),file=await db.prepare('SELECT * FROM attachments WHERE id=?').bind(id).first();if(!file)fail('Attachment not found.',404);
    const chunks=await db.prepare('SELECT data FROM attachment_chunks WHERE attachment_id=? ORDER BY position').bind(id).all();
    const bytes=new Uint8Array(file.size);let offset=0;for(const chunk of chunks.results){const b=atob(chunk.data);for(let i=0;i<b.length;i++)bytes[offset++]=b.charCodeAt(i);}
    return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'Cache-Control':'no-store'}});
  }
  if(path==='/api/export'){
    const data=await queryRecords(db,url.searchParams,false),format=url.searchParams.get('format')==='json'?'json':'csv';
    const headers=['tap_code','country','verification_status','country_source','imsi_prefix','service','direction','status','source_sheet','source_row','created_at','terminated_at'];
    await logStatement(db,{action:'Data export',reason:`Exported ${data.total} records as ${format.toUpperCase()}. Filters: ${JSON.stringify(Object.fromEntries(url.searchParams))}`,executor:user.name,actor:user.username,snapshot:{count:data.total,filters:Object.fromEntries(url.searchParams)}}).run();
    const content=format==='json'?JSON.stringify(data.rows,null,2):toCSV(data.rows,headers);
    return new Response(content,{headers:{'Content-Type':format==='json'?'application/json':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="Umniah-Roaming-Database-${now().slice(0,10)}.${format}"`,'Cache-Control':'no-store'}});
  }
  if(path==='/api/countries'){
    const rows=await db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM partners p WHERE p.tap_code=c.tap_code AND p.status='Active') records FROM countries c ORDER BY c.tap_code`).all();return json({rows:rows.results});
  }
  if(path==='/api/countries/import'&&method==='POST'){
    canWrite(user);const body=await req.json(),note=validateNote(body);if(!Array.isArray(body.rows)||!body.rows.length||body.rows.length>2000)fail('Provide 1–2000 country mappings.');
    const seen=new Set(),at=now(),logId=uid();
    const normalized=body.rows.map(r=>{
      const tap=required(r.tap_code,'TAP code',5).toUpperCase();if(!/^[A-Z0-9]{5}$/.test(tap)||seen.has(tap))fail('Invalid or duplicate TAP code: '+tap);seen.add(tap);
      const country=required(r.country,'Country',100),source=required(body.source,'RAEX source reference',500);
      return {tap_code:tap,country,source};
    });
    const before=await db.prepare(`SELECT * FROM countries`).all();
    const statements=[];for(let i=0;i<normalized.length;i+=250)statements.push(db.prepare(`INSERT INTO countries SELECT json_extract(value,'$.tap_code'),json_extract(value,'$.country'),json_extract(value,'$.source'),'raex_export',? FROM json_each(?) WHERE true ON CONFLICT(tap_code) DO UPDATE SET country=excluded.country,source=excluded.source,verification_status=excluded.verification_status,country_note=excluded.country_note`).bind('Imported from the RAEX export supplied by '+user.username,JSON.stringify(normalized.slice(i,i+250))));
    await db.batch([...statements,logStatement(db,{id:logId,action:'Country mapping import',...note,actor:user.username,snapshot:{source:body.source,mappings:normalized,previous:before.results.filter(r=>seen.has(r.tap_code))},at})]);return json({updated:normalized.length,at});
  }
  if(path==='/api/users'){
    if(user.role!=='admin')fail('Administrator access required.',403);
    if(method==='GET')return json({rows:(await db.prepare('SELECT u.id,u.username,u.name,u.role,u.created_at,e.email FROM users u LEFT JOIN user_emails e ON e.user_id=u.id ORDER BY u.created_at').all()).results,password_reset_email_available:recoveryMailConfigured(env)});
    if(method==='POST'){
      const b=await req.json(),username=required(b.username,'Username',80).toLowerCase(),name=required(b.name,'Name',100),password=validatePassword(b.password),role=b.role;
      if(!['admin','editor','viewer'].includes(role))fail('Select a valid role.');
      const salt=uid(),id=uid(),at=now(),hash=await passwordHash(password,salt);
      const email=b.email?validateEmail(b.email):null;
      try{await db.batch([db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').bind(id,username,name,hash,salt,role,at),...(email?[db.prepare('INSERT INTO user_emails VALUES(?,?,?)').bind(id,email,at)]:[]),logStatement(db,{action:'User created',reason:`Created ${role} account ${username}`,executor:user.name,actor:user.username,snapshot:{id,username,name,role},at})]);}catch(e){if(String(e).includes('UNIQUE'))fail('Username or recovery email already exists.',409);throw e;}return json({ok:true},201);
    }
  }
  fail('Not found.',404);
}
export default {
  async fetch(req,env,ctx){
    const url=new URL(req.url);let response;
    try{response=url.pathname.startsWith('/api/')?await handleApi(req,env,url,ctx):await env.ASSETS.fetch(req);}
    catch(e){console.error('Request error',e.status||500,e.message);response=json({error:e.status?e.message:'The action could not be completed. Please retry.'},e.status||500);}
    const out=new Response(response.body,response);
    out.headers.set('X-Content-Type-Options','nosniff');out.headers.set('Referrer-Policy','same-origin');
    out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
    return out;
  }
};
