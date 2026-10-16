// Durable administrator requests and authorized document-feed synchronization.
const opsJson=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
function opsFail(message,status=400){throw Object.assign(new Error(message),{status});}
const opsNow=()=>new Date().toISOString();
const opsHash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const opsTextHash=text=>opsHash(new TextEncoder().encode(text));
const opsAdmin=user=>{if(user.role!=='admin')opsFail('Administrator access required.',403);};
const opsMax=3*1024*1024;

export async function initializeOperations(db){
  await db.batch([
    `CREATE TABLE IF NOT EXISTS password_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Pending',requested_at TEXT NOT NULL,done_at TEXT,done_by TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS one_pending_password_request ON password_requests(user_id) WHERE status='Pending'`,
    `CREATE TABLE IF NOT EXISTS raex_documents(id TEXT PRIMARY KEY,tap_code TEXT NOT NULL,kind TEXT NOT NULL,revision TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,source TEXT NOT NULL,source_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(tap_code,kind,sha256))`,
    `CREATE TABLE IF NOT EXISTS raex_current(tap_code TEXT NOT NULL,kind TEXT NOT NULL,document_id TEXT NOT NULL,source_at TEXT NOT NULL,PRIMARY KEY(tap_code,kind))`,
    `CREATE TABLE IF NOT EXISTS raex_chunks(document_id TEXT NOT NULL,position INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(document_id,position))`,
    `CREATE TABLE IF NOT EXISTS document_updates(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS document_update_reads(user_id TEXT NOT NULL,update_id TEXT NOT NULL,PRIMARY KEY(user_id,update_id))`
  ].map(sql=>db.prepare(sql)));
}

export async function queuePasswordRequest(db,userId){
  const id=crypto.randomUUID(),at=opsNow();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO password_requests(id,user_id,requested_at) VALUES(?,?,?)").bind(id,userId,at),
    db.prepare("INSERT INTO logs SELECT ?,'Password reset requested',NULL,NULL,?,?,?, ?,? WHERE EXISTS(SELECT 1 FROM password_requests WHERE id=?)").bind(id,'Administrator identity verification required','Account recovery','Account recovery',at,JSON.stringify({user_id:userId}),id)
  ]);
}

function opsDocument(record,bytes){
  const tap=String(record.tap_code||'').trim().toUpperCase(),kind=String(record.kind||'').toUpperCase();
  if(!/^[A-Z0-9]{5}$/.test(tap)||!['IR21','IR85'].includes(kind))opsFail('Select a five-character TAP code and IR21 or IR85.');
  const revision=String(record.revision||'').trim();if(!revision||revision.length>100)opsFail('Document version is required (maximum 100 characters).');
  const filename=String(record.filename||'').replace(/[\x00-\x1f\x7f"\\/]/g,'_').slice(0,180);
  const ext=filename.split('.').pop().toLowerCase(),prefix=new TextDecoder().decode(bytes.subarray(0,512)).trimStart();
  if(!bytes.length||bytes.length>opsMax)opsFail('Each document must be nonempty and no larger than 3 MB.');
  if(!['pdf','xml'].includes(ext)||(ext==='pdf'&&!prefix.startsWith('%PDF-'))||(ext==='xml'&&!prefix.startsWith('<')))opsFail('Upload an original PDF or XML document with matching content.');
  const date=Date.parse(record.source_at);if(!Number.isFinite(date)||date>Date.now()+300000)opsFail('Provide the document issue date; future dates are not accepted.');
  return {tap,kind,revision,filename,mime:ext==='pdf'?'application/pdf':'application/xml',sourceAt:new Date(date).toISOString()};
}

async function opsSaveDocument(db,record,bytes,source,actor){
  const d=opsDocument(record,bytes);
  if(!await db.prepare('SELECT 1 FROM partners WHERE tap_code=? LIMIT 1').bind(d.tap).first()){
    if(source==='Authorized RAEX feed')return {changed:false,skipped:true};
    opsFail('This TAP code is not in the roaming database.');
  }
  const current=await db.prepare('SELECT d.sha256,c.source_at FROM raex_current c JOIN raex_documents d ON d.id=c.document_id WHERE c.tap_code=? AND c.kind=?').bind(d.tap,d.kind).first();
  const hash=await opsHash(bytes);
  if(current?.sha256===hash)return {changed:false};
  if(current&&d.sourceAt<=current.source_at){
    if(source==='Authorized RAEX feed')return {changed:false,skipped:true};
    opsFail('The issue date must be newer than the current document. Existing documents were preserved.',409);
  }
  const id=await opsTextHash(d.tap+'|'+d.kind+'|'+hash),at=opsNow();
  // A previously stored version must not be promoted with a misleading newer date.
  if(await db.prepare('SELECT id FROM raex_documents WHERE id=?').bind(id).first())opsFail('This content is already stored in document history.',409);
  const statements=[db.prepare('INSERT OR IGNORE INTO raex_documents VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,d.tap,d.kind,d.revision,d.filename,d.mime,hash,bytes.length,source,d.sourceAt,at)];
  for(let i=0,p=0;i<bytes.length;i+=196608,p++){
    let binary='';for(const b of bytes.subarray(i,i+196608))binary+=String.fromCharCode(b);
    statements.push(db.prepare('INSERT OR IGNORE INTO raex_chunks VALUES(?,?,?)').bind(id,p,btoa(binary)));
  }
  statements.push(db.prepare('INSERT INTO raex_current VALUES(?,?,?,?) ON CONFLICT(tap_code,kind) DO UPDATE SET document_id=excluded.document_id,source_at=excluded.source_at WHERE excluded.source_at>raex_current.source_at').bind(d.tap,d.kind,id,d.sourceAt));
  statements.push(db.prepare('INSERT OR IGNORE INTO document_updates SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM raex_current WHERE document_id=?)').bind(id,id,at,id));
  statements.push(db.prepare("INSERT OR IGNORE INTO logs SELECT ?,'RAEX document updated',NULL,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM document_updates WHERE id=?)").bind('document-'+id,d.tap,`${d.kind} version ${d.revision} added from ${source}`,actor,actor,at,JSON.stringify({document_id:id,kind:d.kind,sha256:hash}),id));
  await db.batch(statements);
  return {changed:true,id};
}

export async function runRaexAgent(db,env,request=fetch){
  if(!env.RAEX_FEED_URL||!env.RAEX_FEED_TOKEN)return {status:'awaiting_access',message:'An authorized RAEX export feed is not configured.'};
  const feed=new URL(env.RAEX_FEED_URL);
  // The fixed feed is configured privately by deployment administrators, never by browser users.
  if(feed.protocol!=='https:'||feed.username||feed.password||feed.search||feed.hash||/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|\[)/i.test(feed.hostname))opsFail('The authorized feed URL must use HTTPS without credentials, query or fragment.');
  const at=opsNow(),lease=String(Date.now()+90000);
  const acquired=await db.prepare("INSERT INTO metadata VALUES('raex_agent_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(metadata.value AS INTEGER)<?").bind(lease,Date.now()).run();
  if(!acquired.meta.changes)return {status:'running'};
  try{
    const cursor=await db.prepare("SELECT value FROM metadata WHERE key='raex_agent_cursor'").first();
    if(cursor?.value)feed.searchParams.set('cursor',cursor.value);
    const response=await request(feed.href,{headers:{Authorization:'Bearer '+env.RAEX_FEED_TOKEN,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('feed_unavailable');
    let length=0,parts=[];for await(const part of response.body){length+=part.length;if(length>4*1024*1024)throw new Error('feed_too_large');parts.push(part);}
    const body=JSON.parse(new TextDecoder().decode(new Uint8Array(await new Blob(parts).arrayBuffer())));
    if(!Array.isArray(body.documents)||body.documents.length>20||typeof(body.next_cursor??'')!=='string'||String(body.next_cursor||'').length>1000)throw new Error('feed_invalid');
    let changed=0;
    for(const record of body.documents){
      if(typeof record.content_base64!=='string'||record.content_base64.length>4*1024*1024||record.content_base64.length%4||/[^A-Za-z0-9+/=]/.test(record.content_base64))throw new Error('feed_invalid');
      const bytes=Uint8Array.from(atob(record.content_base64),c=>c.charCodeAt(0));
      const saved=await opsSaveDocument(db,record,bytes,'Authorized RAEX feed','RAEX document agent');if(saved.changed)changed++;
    }
    const result={status:'success',checked:body.documents.length,updated:changed,at};
    await db.batch([
      db.prepare("INSERT INTO metadata VALUES('raex_agent_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(body.next_cursor||''),
      db.prepare("INSERT INTO metadata VALUES('raex_agent_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(result))
    ]);return result;
  }catch{
    await db.prepare("INSERT INTO metadata VALUES('raex_agent_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({status:'failed',at,message:'Sync did not complete. Stored documents are preserved. Ask the administrator to check the authorized feed.'})).run();
    opsFail('RAEX sync did not complete. Existing documents were preserved.',502);
  }finally{await db.prepare("DELETE FROM metadata WHERE key='raex_agent_lock' AND value=?").bind(lease).run();}
}

export async function handleOperations({req,env,db,url,user}){
  const path=url.pathname,method=req.method;
  if(path==='/api/password-requests'&&method==='GET'){
    opsAdmin(user);
    const page=Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1));
    const status=url.searchParams.get('status')==='Done'?'Done':'Pending';
    const rows=await db.prepare('SELECT r.*,u.username,u.name FROM password_requests r JOIN users u ON u.id=r.user_id WHERE r.status=? ORDER BY r.requested_at DESC LIMIT 50 OFFSET ?').bind(status,(page-1)*50).all();
    const count=await db.prepare('SELECT COUNT(*) total FROM password_requests WHERE status=?').bind(status).first();
    return opsJson({rows:rows.results,total:count.total,page,limit:50});
  }
  if(path==='/api/notifications'&&method==='GET'){
    const updates=await db.prepare('SELECT n.id,n.at,d.tap_code,d.kind,d.revision FROM document_updates n JOIN raex_documents d ON d.id=n.document_id WHERE NOT EXISTS(SELECT 1 FROM document_update_reads r WHERE r.user_id=? AND r.update_id=n.id) ORDER BY n.at DESC LIMIT 50').bind(user.id).all();
    const count=await db.prepare('SELECT COUNT(*) total FROM document_updates n WHERE NOT EXISTS(SELECT 1 FROM document_update_reads r WHERE r.user_id=? AND r.update_id=n.id)').bind(user.id).first();
    const pending=user.role==='admin'?(await db.prepare("SELECT COUNT(*) total FROM password_requests WHERE status='Pending'").first()).total:0;
    return opsJson({updates:updates.results,unread:count.total,password_requests:pending});
  }
  if(path==='/api/notifications/read'&&method==='POST'){
    const b=await req.json();if(!Array.isArray(b.ids)||b.ids.length>50)opsFail('Select up to 50 notifications.');
    if(b.ids.length)await db.batch(b.ids.map(id=>db.prepare('INSERT OR IGNORE INTO document_update_reads SELECT ?,id FROM document_updates WHERE id=?').bind(user.id,String(id))));
    return opsJson({ok:true});
  }
  if(path==='/api/raex/documents'&&method==='GET'){
    const q='%'+String(url.searchParams.get('q')||'').slice(0,100)+'%',kind=['IR21','IR85'].includes(url.searchParams.get('kind'))?url.searchParams.get('kind'):'';
    const missing=url.searchParams.get('missing')==='1',page=Math.max(1,Math.floor(Number(url.searchParams.get('page'))||1));
    const from=` FROM (SELECT DISTINCT tap_code FROM partners) p CROSS JOIN (SELECT 'IR21' kind UNION ALL SELECT 'IR85') k LEFT JOIN raex_current c ON c.tap_code=p.tap_code AND c.kind=k.kind LEFT JOIN raex_documents d ON d.id=c.document_id WHERE p.tap_code LIKE ? AND (?='' OR k.kind=?)${missing?' AND d.id IS NULL':''}`;
    const rows=await db.prepare('SELECT p.tap_code,k.kind,d.id,d.revision,d.filename,d.bytes,d.source,d.source_at,d.created_at'+from+' ORDER BY p.tap_code,k.kind LIMIT 50 OFFSET ?').bind(q,kind,kind,(page-1)*50).all();
    const count=await db.prepare('SELECT COUNT(*) total'+from).bind(q,kind,kind).first();
    const last=await db.prepare("SELECT value FROM metadata WHERE key='raex_agent_status'").first();
    return opsJson({rows:rows.results,total:count.total,page,limit:50,agent:{configured:!!(env.RAEX_FEED_URL&&env.RAEX_FEED_TOKEN),schedule:env.CRON_SECRET?'Daily in the 09:00 hour (UTC+3, hosting schedule)':'Manual checks only; the scheduler secret is not configured',last:last?JSON.parse(last.value):null}});
  }
  if(path==='/api/raex/history'&&method==='GET'){
    const rows=await db.prepare('SELECT id,revision,filename,bytes,source,source_at,created_at FROM raex_documents WHERE tap_code=? AND kind=? ORDER BY source_at DESC LIMIT 50').bind(url.searchParams.get('tap_code'),url.searchParams.get('kind')).all();
    return opsJson({rows:rows.results});
  }
  if(path==='/api/raex/upload'&&method==='POST'){
    opsAdmin(user);const form=await req.formData(),file=form.get('attachment');
    if(!file||typeof file==='string')opsFail('Select an IR21 or IR85 document.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    return opsJson(await opsSaveDocument(db,{...Object.fromEntries(form),filename:file.name},bytes,'Administrator upload (verify against RAEX)',user.username));
  }
  if(path==='/api/raex/sync'&&method==='POST'){opsAdmin(user);return opsJson(await runRaexAgent(db,env));}
  const download=path.match(/^\/api\/raex\/download\/([a-f0-9]{64})$/);
  if(download&&method==='GET'){
    const doc=await db.prepare('SELECT * FROM raex_documents WHERE id=?').bind(download[1]).first();if(!doc)opsFail('Document not found.',404);
    const chunks=await db.prepare('SELECT data FROM raex_chunks WHERE document_id=? ORDER BY position').bind(doc.id).all();
    const parts=chunks.results.map(row=>Uint8Array.from(atob(row.data),c=>c.charCodeAt(0)));
    return new Response(new Blob(parts),{headers:{'Content-Type':doc.mime,'Content-Disposition':`attachment; filename="${doc.filename}"`,'Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; sandbox"}});
  }
  return null;
}
