import {esc,header,table,formatTime,empty} from './ui.js';
import {wireAdminPasswords} from './account.js';
const post=(api,path,body)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

export async function passwordRequestsPage(content,api,onSignedOut,toast){
  let status=content.dataset.requestStatus||'Pending',page=Number(content.dataset.requestPage)||1;
  async function refresh(){
    content.dataset.requestStatus=status;content.dataset.requestPage=String(page);
    const data=await api('/api/password-requests?'+new URLSearchParams({status,page}));if(!content.isConnected)return;
    content.innerHTML=header('Password reset requests','Shared with every administrator. Verify identity before setting a replacement password.',`<button class="btn" id="refresh-requests">Refresh</button>`)+`<div class="notice info">The first successful administrator reset completes the request for everyone. Arrange password handover through your approved company channel.</div><div class="filters"><label for="request-status">Request status</label><select id="request-status"><option ${status==='Pending'?'selected':''}>Pending</option><option ${status==='Done'?'selected':''}>Done</option></select></div><section class="panel">${table(['Account','Requested · UTC+3','Status','Completed by','Completed · UTC+3','Action'],data.rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong><div class="muted">${esc(r.username)}</div></td><td>${formatTime(r.requested_at)}</td><td><span class="badge ${r.status==='Done'?'request-done':''}">${esc(r.status)}</span></td><td>${esc(r.done_by||'—')}</td><td>${r.done_at?formatTime(r.done_at):'—'}</td><td>${r.status==='Pending'?`<button class="btn small primary" data-reset-user="${esc(r.user_id)}">Reset & complete</button>`:'<strong class="done-label">✓ Done</strong>'}</td></tr>`),empty('No '+status.toLowerCase()+' requests','Requests from the login page appear here.'))}<div class="table-footer"><span>${data.total} requests</span><div class="actions"><button class="btn small" id="requests-prev" ${page===1?'disabled':''}>Previous</button><span>Page ${page}</span><button class="btn small" id="requests-next" ${page*50>=data.total?'disabled':''}>Next</button></div></div></section>`;
    document.querySelector('#request-status').onchange=e=>{status=e.target.value;page=1;refresh().catch(e=>toast(e.message));};
    document.querySelector('#refresh-requests').onclick=()=>refresh().catch(e=>toast(e.message));
    document.querySelector('#requests-prev').onclick=()=>{page--;refresh().catch(e=>toast(e.message));};
    document.querySelector('#requests-next').onclick=()=>{page++;refresh().catch(e=>toast(e.message));};
    wireAdminPasswords(data.rows.map(r=>({...r,id:r.user_id,request_id:r.id})),false,api,async()=>{status='Done';page=1;await refresh();},onSignedOut,toast);
  }
  await refresh();
}

export async function documentsPage(content,api,role,toast){
  let q='',kind='',missing=false,page=1;
  async function refresh(){
    const data=await api('/api/raex/documents?'+new URLSearchParams({q,kind,missing:missing?'1':'0',page}));if(!content.isConnected)return;
    const agent=data.agent;
    content.innerHTML=header('IR21 & IR85 documents','Find current partner documents by TAP code, with earlier versions kept in history.')+`<div class="notice info"><div><strong>RAEX document agent · ${agent.configured?'Authorized export feed configured':'Awaiting authorized RAEX access'}</strong><p>${agent.configured?esc(agent.schedule):'Automatic downloads are unavailable until authorized RAEX/API or export-feed access is supplied. Missing documents are shown for every TAP code; IR85 applies to roaming hubs and may not exist for an operator.'}</p>${agent.last?`<small>Last run: ${esc(agent.last.status)} · ${formatTime(agent.last.at)}${agent.last.message?' · '+esc(agent.last.message):''}</small>`:''}</div></div>${role==='admin'?`<div class="actions document-actions"><button class="btn" id="sync-raex" ${!agent.configured?'disabled':''}>Check feed now</button><button class="btn primary" id="upload-document">Add authorized document</button></div>`:''}<section class="panel"><form class="filters" id="document-filters"><input name="q" aria-label="Search document TAP code" placeholder="Search TAP code…" value="${esc(q)}" maxlength="100"><select name="kind" aria-label="Document type"><option value="">IR21 & IR85</option><option ${kind==='IR21'?'selected':''}>IR21</option><option ${kind==='IR85'?'selected':''}>IR85</option></select><label><input type="checkbox" name="missing" ${missing?'checked':''}> Missing only</label><button class="btn" type="submit">Search</button></form>${table(['TAP code','Type','Version','Issue date · UTC+3','Source','Attachment'],data.rows.map(r=>`<tr><td class="mono">${esc(r.tap_code)}</td><td>${esc(r.kind)}</td><td>${r.id?esc(r.revision):'<span class="muted">Not available</span>'}</td><td>${r.source_at?formatTime(r.source_at):'—'}</td><td>${esc(r.source||'Awaiting authorized document')}</td><td>${r.id?`<a class="btn small" href="/api/raex/download/${esc(r.id)}" download>Download</a> <button class="btn small" data-history-tap="${esc(r.tap_code)}" data-history-kind="${esc(r.kind)}">History</button>`:'—'}</td></tr>`),empty('No matching documents','Adjust your TAP code or document filter.'))}<div class="table-footer"><span>${data.total} TAP / document entries</span><div class="actions"><button class="btn small" id="docs-prev" ${page===1?'disabled':''}>Previous</button><span>Page ${page}</span><button class="btn small" id="docs-next" ${page*50>=data.total?'disabled':''}>Next</button></div></div></section>`;
    document.querySelector('#document-filters').onsubmit=e=>{e.preventDefault();const fields=new FormData(e.currentTarget);q=fields.get('q');kind=fields.get('kind');missing=fields.has('missing');page=1;refresh().catch(e=>toast(e.message));};
    document.querySelector('#docs-prev').onclick=()=>{page--;refresh().catch(e=>toast(e.message));};
    document.querySelector('#docs-next').onclick=()=>{page++;refresh().catch(e=>toast(e.message));};
    document.querySelector('#sync-raex')?.addEventListener('click',async e=>{e.currentTarget.disabled=true;try{const result=await post(api,'/api/raex/sync',{});toast(result.status==='success'?`${result.updated} document updates saved.`:result.message||'Agent is already running.');await refresh();}catch(error){toast(error.message);await refresh();}});
    document.querySelector('#upload-document')?.addEventListener('click',()=>uploadDialog(api,refresh,toast));
    for(const button of document.querySelectorAll('[data-history-tap]'))button.onclick=async()=>{
      try{
        const history=await api('/api/raex/history?'+new URLSearchParams({tap_code:button.dataset.historyTap,kind:button.dataset.historyKind}));
        document.querySelector('#detail-content').innerHTML=`<div class="dialog-head"><h2>${esc(button.dataset.historyTap)} · ${esc(button.dataset.historyKind)} history</h2><button class="btn" id="close-history">Close</button></div><div class="dialog-body">${table(['Version','Issue date · UTC+3','Source','File'],history.rows.map(r=>`<tr><td>${esc(r.revision)}</td><td>${formatTime(r.source_at)}</td><td>${esc(r.source)}</td><td><a href="/api/raex/download/${esc(r.id)}" download>${esc(r.filename)}</a></td></tr>`))}</div>`;
        const dialog=document.querySelector('#detail-dialog');document.querySelector('#close-history').onclick=()=>dialog.close();dialog.showModal();
      }catch(error){toast(error.message);}
    };
  }
  await refresh();
}

function uploadDialog(api,onDone,toast){
  const dialog=document.querySelector('#detail-dialog');
  document.querySelector('#detail-content').innerHTML=`<div class="dialog-head"><h2>Add IR21 / IR85 document</h2><button class="btn" id="close-document">Close</button></div><form class="dialog-body account-form" id="document-upload"><p class="muted">Upload only a document your organization is authorized to use. This upload is labelled as administrator-supplied, not RAEX-verified.</p><div class="form-grid"><div class="field"><label for="doc-tap">TAP code</label><input id="doc-tap" name="tap_code" required pattern="[A-Za-z0-9]{5}" maxlength="5"></div><div class="field"><label for="doc-kind">Document type</label><select id="doc-kind" name="kind"><option>IR21</option><option>IR85</option></select></div><div class="field"><label for="doc-version">Version</label><input id="doc-version" name="revision" required maxlength="100"></div><div class="field"><label for="doc-date">Document issue date and time</label><input id="doc-date" name="source_at" type="datetime-local" required></div><div class="field span-two"><label for="doc-file">Original PDF or XML · maximum 3 MB</label><input id="doc-file" name="attachment" type="file" accept=".pdf,.xml" required></div></div><div class="error-text" id="document-error" role="alert"></div><button class="btn primary" type="submit">Save document & notify users</button></form>`;
  document.querySelector('#close-document').onclick=()=>dialog.close();
  document.querySelector('#document-upload').onsubmit=async event=>{
    event.preventDefault();const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;
    try{const form=new FormData(event.currentTarget);form.set('source_at',new Date(form.get('source_at')).toISOString());const result=await api('/api/raex/upload',{method:'POST',body:form});dialog.close();toast(result.changed?'Document saved. Update notification added for all users.':'The same document is already current.');await onDone();}
    catch(error){document.querySelector('#document-error').textContent=error.message;}
    finally{button.disabled=false;}
  };dialog.showModal();
}

export async function notificationsPage(content,api,toast,onRefresh){
  const data=await api('/api/notifications');if(!content.isConnected)return;
  content.innerHTML=header('Notifications','Document updates are recorded for every user. Your read status is personal.')+`<section class="panel"><div class="panel-head"><h2>${data.unread} unread document updates</h2><button class="btn" id="mark-updates" ${!data.updates.length?'disabled':''}>Mark displayed as read</button></div>${table(['TAP code','Document','Version','Updated · UTC+3'],data.updates.map(n=>`<tr><td>${esc(n.tap_code)}</td><td>${esc(n.kind)}</td><td>${esc(n.revision)}</td><td>${formatTime(n.at)}</td></tr>`),empty('You are up to date','New IR21 / IR85 versions will appear here.'))}</section>`;
  document.querySelector('#mark-updates').onclick=async()=>{try{await post(api,'/api/notifications/read',{ids:data.updates.map(n=>n.id)});await notificationsPage(content,api,toast,onRefresh);await onRefresh();}catch(error){toast(error.message);}};
}
