import worker from '../dist/worker.js';
import {createClient} from '@libsql/client/http';
import {createDatabaseAdapter} from '../src/libsql-adapter.mjs';
import {waitUntil,ipAddress} from '@vercel/functions';
let database;
export const config={api:{bodyParser:false}};
export default async function handler(req,res){
  try{
    if(!process.env.TURSO_DATABASE_URL||!process.env.TURSO_AUTH_TOKEN||!process.env.SETUP_CODE){
      res.statusCode=503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({error:'Hosting configuration is incomplete. Configure the database and private setup code in Vercel.'}));return;
    }
    if(!database)database=createDatabaseAdapter(createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN,intMode:'number'}));
    const pieces=[];let size=0;
    for await(const piece of req){size+=piece.length;if(size>4.25*1024*1024){res.statusCode=413;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Request is too large. Attachments must total 4 MB or smaller.'}));return;}pieces.push(piece);}
    const headers=new Headers();for(const[key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
    const host=req.headers.host||process.env.VERCEL_URL;
    const parsed=new URL(req.url||'/api/auth/status',`https://${host}`);
    const route=req.query?.__route||parsed.searchParams.get('__route');
    parsed.searchParams.delete('__route');
    const pathname=route?'/api/'+String(route):parsed.pathname;
    const originalPath=pathname+(parsed.search?'?'+parsed.searchParams.toString():'');
    const request=new Request(`https://${host}${originalPath}`,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(pieces)})});
    request.headers.set('CF-Connecting-IP',ipAddress(request)||'unknown');
    const response=await worker.fetch(request,{DB:database,SETUP_CODE:process.env.SETUP_CODE,APP_ORIGIN:process.env.APP_ORIGIN,M365_TENANT_ID:process.env.M365_TENANT_ID,M365_CLIENT_ID:process.env.M365_CLIENT_ID,M365_CLIENT_SECRET:process.env.M365_CLIENT_SECRET,M365_SENDER:process.env.M365_SENDER,ASSETS:{fetch:async()=>new Response('Not found',{status:404})}},{waitUntil});
    res.statusCode=response.status;response.headers.forEach((value,key)=>res.setHeader(key,value));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){console.error('Hosted request failed:',e.code||e.name);res.statusCode=500;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({error:'The database could not be reached. Ask the administrator to check the hosting configuration.'}));}
}
