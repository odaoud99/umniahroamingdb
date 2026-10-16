import {esc,header,icon} from './ui.js';

const post=(api,path,data)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const newPasswordFields=(prefix='new')=>`<div class="field"><label for="${prefix}-password">New password</label><input id="${prefix}-password" name="new_password" type="password" required minlength="12" maxlength="200" autocomplete="new-password"><small>Use 12–200 characters.</small></div><div class="field"><label for="${prefix}-confirm">Confirm new password</label><input id="${prefix}-confirm" name="confirm_password" type="password" required minlength="12" maxlength="200" autocomplete="new-password"></div>`;
const confirmNewPassword=data=>{if(data.new_password!==data.confirm_password)throw new Error('The new passwords do not match.');};
const mailNotice=()=> 'Forgotten-password requests go to every administrator. An administrator verifies your identity, resets the password, and marks the request Done.';

export function renderForgotPassword(root,api,onBack){
  root.innerHTML=`<main class="recovery-page"><section class="panel recovery-card"><div class="panel-body"><div class="eyebrow">Umniah Roaming Database</div><h1>Forgot your password?</h1><p class="subtitle">Enter your username or saved recovery email. We will send a password-reset request to all administrators. They will verify your identity and arrange your new password.</p><form id="forgot-form"><div class="field"><label for="recovery-identifier">Username or recovery email</label><input id="recovery-identifier" name="identifier" required maxlength="254" autocomplete="username"></div><div class="error-text" id="forgot-error" role="alert"></div><p id="forgot-result" class="form-message" role="status"></p><button type="submit" class="btn primary">Request administrator reset</button></form><button class="text-button" id="back-to-login" type="button">Back to sign in</button></div></section></main>`;
  document.querySelector('#back-to-login').onclick=onBack;
  document.querySelector('#forgot-form').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
    document.querySelector('#forgot-error').textContent='';document.querySelector('#forgot-result').textContent='';
    try{const result=await post(api,'/api/auth/forgot-password',Object.fromEntries(new FormData(form)));document.querySelector('#forgot-result').textContent=result.message;form.reset();}
    catch(error){document.querySelector('#forgot-error').textContent=error.message;}
    finally{button.disabled=false;}
  };
}

export function renderPasswordReset(root,token,api,onDone,onBack){
  root.innerHTML=`<main class="recovery-page"><section class="panel recovery-card"><div class="panel-body"><div class="eyebrow">Umniah Roaming Database</div><h1>Choose a new password</h1><p class="subtitle">Your email link works once and expires after 30 minutes. After saving, sign in again on your devices.</p><form id="reset-password-form">${newPasswordFields('reset')}<div class="error-text" id="reset-error" role="alert"></div><button class="btn primary" type="submit">Save new password</button></form><button class="text-button" type="button" id="reset-back">Back to sign in</button></div></section></main>`;
  document.querySelector('#reset-back').onclick=onBack;
  document.querySelector('#reset-password-form').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;document.querySelector('#reset-error').textContent='';
    try{const data=Object.fromEntries(new FormData(form));confirmNewPassword(data);await post(api,'/api/auth/reset-password',{token,new_password:data.new_password});form.reset();await onDone();}
    catch(error){document.querySelector('#reset-error')?.replaceChildren(document.createTextNode(error.message));}
    finally{button.disabled=false;}
  };
}

export async function accountPage(content,api,onPasswordChanged,toast){
  const profile=await api('/api/account');
  if(!content.isConnected)return;
  content.innerHTML=header('My account','Manage your password and recovery email.')+`<div class="notice info">${icon('info')}<span>${mailNotice(profile.password_reset_email_available)}</span></div><div class="two-cols"><section class="panel"><div class="panel-head"><h2>Change password</h2></div><form class="panel-body account-form" id="change-password-form"><div class="field"><label for="current-password">Current password</label><input id="current-password" name="current_password" type="password" required maxlength="200" autocomplete="current-password"></div>${newPasswordFields('account')}<p class="subtitle">Saving signs you out on all devices.</p><div class="error-text" id="password-error" role="alert"></div><button class="btn primary" type="submit">Change password</button></form></section><section class="panel"><div class="panel-head"><h2>Recovery email</h2></div><form class="panel-body account-form" id="recovery-email-form"><p class="muted">Use a company mailbox you control. You can use this address to identify your account when requesting an administrator reset.</p><div class="field"><label for="recovery-email">Recovery email address</label><input id="recovery-email" name="email" type="email" required maxlength="254" value="${esc(profile.email)}" autocomplete="email"></div><div class="field"><label for="email-current-password">Confirm your current password</label><input id="email-current-password" name="current_password" type="password" required maxlength="200" autocomplete="current-password"></div><div class="error-text" id="email-error" role="alert"></div><button class="btn" type="submit">Save recovery email</button></form></section></div>`;
  document.querySelector('#change-password-form').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;document.querySelector('#password-error').textContent='';
    try{const data=Object.fromEntries(new FormData(form));confirmNewPassword(data);await post(api,'/api/auth/change-password',data);form.reset();await onPasswordChanged();}
    catch(error){document.querySelector('#password-error')?.replaceChildren(document.createTextNode(error.message));}
    finally{button.disabled=false;}
  };
  document.querySelector('#recovery-email-form').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;document.querySelector('#email-error').textContent='';
    try{await post(api,'/api/account/email',Object.fromEntries(new FormData(form)));form.querySelector('[name=current_password]').value='';toast('Recovery email saved. Previous reset links are invalid.');}
    catch(error){document.querySelector('#email-error').textContent=error.message;}
    finally{button.disabled=false;}
  };
}

export function wireAdminPasswords(rows,mailEnabled,api,onRefresh,onSignedOut,toast){
  for(const button of document.querySelectorAll('[data-reset-user]'))button.onclick=()=>{
    const user=rows.find(row=>row.id===button.dataset.resetUser);if(!user)return;
    const dialog=document.querySelector('#detail-dialog');
    document.querySelector('#detail-content').innerHTML=`<div class="dialog-head"><div><div class="eyebrow">User access</div><h2>Reset password · ${esc(user.name)}</h2></div><button class="btn ghost" type="button" id="close-password-dialog" aria-label="Close password reset">${icon('close')}</button></div><form id="admin-password-form" class="dialog-body account-form">${user.request_id?`<input type="hidden" name="request_id" value="${esc(user.request_id)}">`:""}<p class="muted">Account: ${esc(user.username)}</p><div class="field"><label for="admin-reset-mode">Action</label><select id="admin-reset-mode" name="mode" ${user.request_id?'aria-label="Request completion action"':''}><option value="reset-password">Set a replacement password</option><option value="reset-email" ${user.request_id||!mailEnabled||!user.email?'disabled':''}>Email a reset link</option><option value="email" ${user.request_id?'disabled':''}>Update recovery email</option></select></div><p class="form-message">${user.email?'Recovery email: '+esc(user.email):'No recovery email saved. Choose “Update recovery email” to add one.'}</p>${user.request_id?'<p class="notice info">Verify the requester’s identity. A successful reset marks this shared request Done.</p>':''}<div id="admin-new-password-fields">${newPasswordFields('admin')}</div><div class="field" id="admin-email-field" hidden><label for="admin-user-email">Recovery email</label><input id="admin-user-email" name="email" type="email" maxlength="254" value="${esc(user.email||'')}" disabled></div><div class="field"><label for="admin-confirm-password">Your administrator password</label><input id="admin-confirm-password" name="current_password" type="password" required maxlength="200" autocomplete="current-password"></div><div class="field" id="admin-reason-field"><label for="admin-reset-reason">Reason</label><textarea id="admin-reset-reason" name="reason" required maxlength="2000" placeholder="Explain this password reset">${user.request_id?esc("Verified administrator recovery request "+user.request_id):''}</textarea></div><p class="muted">Replacing a password signs this account out on every device. The action is recorded in Logs.</p><div class="error-text" id="admin-reset-error" role="alert"></div><button class="btn primary" type="submit" id="apply-user-reset">Apply password reset</button></form>`;
    document.querySelector('#close-password-dialog').onclick=()=>dialog.close();
    const select=document.querySelector('#admin-reset-mode');
    select.onchange=()=>{
      const password=select.value==='reset-password',email=select.value==='email';
      document.querySelector('#admin-new-password-fields').hidden=!password;
      for(const input of document.querySelectorAll('#admin-new-password-fields input')){input.disabled=!password;input.required=password;input.value='';}
      document.querySelector('#admin-email-field').hidden=!email;document.querySelector('#admin-user-email').disabled=!email;document.querySelector('#admin-user-email').required=email;
      document.querySelector('#admin-reason-field').hidden=email;document.querySelector('#admin-reset-reason').required=!email;
      document.querySelector('#apply-user-reset').textContent=email?'Save recovery email':password?'Apply password reset':'Email reset link';
      document.querySelector('#admin-reset-error').textContent='';
    };
    document.querySelector('#admin-password-form').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;document.querySelector('#admin-reset-error').textContent='';
      try{
        const data=Object.fromEntries(new FormData(form));if(data.mode==='reset-password')confirmNewPassword(data);
        const result=await post(api,`/api/users/${encodeURIComponent(user.id)}/${data.mode}`,data);
        form.reset();dialog.close();
        if(result.signed_out)return onSignedOut();
        toast(data.mode==='email'?'Recovery email saved.':data.mode==='reset-email'?'Password reset email requested. Check Logs for delivery failures.':'Password replaced. Existing sessions have been signed out.');
        await onRefresh();
      }catch(error){document.querySelector('#admin-reset-error')?.replaceChildren(document.createTextNode(error.message));}
      finally{button.disabled=false;}
    };
    dialog.showModal();
  };
}
