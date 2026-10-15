import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
await import('./build.mjs');
const worker=(await import('../dist/worker.js')).default;
const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(resolve(root,'data'),{recursive:true});
const sqlite=new DatabaseSync(process.env.DB_PATH||resolve(root,'data/roaming.sqlite'));
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
class Statement{
  constructor(sql,args=[]){this.sql=sql;this.args=args;}
  bind(...args){return new Statement(this.sql,args);}
  async first(){return sqlite.prepare(this.sql).get(...this.args)||null;}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}
  async run(){const result=sqlite.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}
}
const DB={prepare(sql){return new Statement(sql);},async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=[];for(const statement of statements){const result=sqlite.prepare(statement.sql).all(...statement.args);results.push({success:true,results:result,meta:{changes:Number(sqlite.prepare('SELECT changes() n').get().n)}});}sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.csv':'text/csv; charset=utf-8'};
const ASSETS={async fetch(req){let path=decodeURIComponent(new URL(req.url).pathname);if(path==='/')path='/index.html';const full=resolve(root,'public','.'+path);
  const allowed=resolve(root,'public');if(full!==allowed&&!full.startsWith(allowed+(process.platform==='win32'?'\\':'/')))return new Response('Forbidden',{status:403});
  try{return new Response(await readFile(full),{headers:{'Content-Type':mime[extname(full)]||'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}}};
let SETUP_CODE=process.env.SETUP_CODE;
if(!SETUP_CODE){try{SETUP_CODE=(await readFile(resolve(root,'.dev.vars'),'utf8')).match(/^SETUP_CODE=(.*)$/m)?.[1];}catch{}}
if(!SETUP_CODE){SETUP_CODE=randomBytes(24).toString('base64url');await writeFile(resolve(root,'.dev.vars'),`SETUP_CODE=${SETUP_CODE}\n`);}
const port=Number(process.env.PORT||8787);
const server=http.createServer(async(req,res)=>{try{const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts);const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);const request=new Request(`http://127.0.0.1:${port}${req.url}`,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body})});const response=await worker.fetch(request,{DB,ASSETS,SETUP_CODE,...Object.fromEntries(['APP_ORIGIN','M365_TENANT_ID','M365_CLIENT_ID','M365_CLIENT_SECRET','M365_SENDER'].map(key=>[key,process.env[key]]))},{waitUntil:promise=>promise.catch(()=>console.error('Background email task failed.'))});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){console.error(e.message);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Local server error.'}));}});
server.listen(port,'127.0.0.1',()=>console.log(`Umniah Roaming Database running at http://127.0.0.1:${port}. Setup code is in .dev.vars.`));
process.on('SIGTERM',()=>server.close(()=>{sqlite.close();process.exit();}));
