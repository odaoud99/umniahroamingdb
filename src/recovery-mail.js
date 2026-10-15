export function recoveryMailConfigured(env){
  try{
    const origin=new URL(env.APP_ORIGIN);
    return Boolean(env.M365_TENANT_ID&&env.M365_CLIENT_ID&&env.M365_CLIENT_SECRET&&env.M365_SENDER&&origin.protocol==='https:'&&!origin.username&&!origin.password&&origin.pathname==='/'&&!origin.search&&!origin.hash);
  }catch{return false;}
}

export async function sendPasswordResetEmail(env,to,token,request=fetch){
  if(!recoveryMailConfigured(env))throw new Error('Microsoft 365 recovery email is not configured.');
  const form=new URLSearchParams({client_id:env.M365_CLIENT_ID,client_secret:env.M365_CLIENT_SECRET,scope:'https://graph.microsoft.com/.default',grant_type:'client_credentials'});
  const authorization=await request(`https://login.microsoftonline.com/${encodeURIComponent(env.M365_TENANT_ID)}/oauth2/v2.0/token`,{method:'POST',body:form,signal:AbortSignal.timeout(10000)});
  if(!authorization.ok)throw new Error('Microsoft 365 email authorization failed.');
  const credentials=await authorization.json();
  if(!credentials.access_token)throw new Error('Microsoft 365 email authorization failed.');
  const link=new URL('/#reset-password='+token,env.APP_ORIGIN).href;
  const content=`A password reset was requested for your Umniah Roaming Database account.\n\nChoose a new password using this link:\n${link}\n\nThe link expires in 30 minutes and can be used once. Never share it. If you did not request a reset, you can ignore this message. Your password has not changed.\n\nUmniah Roaming Database`;
  const response=await request(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.M365_SENDER)}/sendMail`,{method:'POST',headers:{Authorization:'Bearer '+credentials.access_token,'Content-Type':'application/json'},body:JSON.stringify({message:{subject:'Reset your Umniah Roaming Database password',body:{contentType:'Text',content},toRecipients:[{emailAddress:{address:to}}]},saveToSentItems:true}),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Microsoft 365 did not accept the recovery email.');
}
