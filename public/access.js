export function canViewPage(role,page){
  if(['logs','users','requests'].includes(page))return role==='admin';
  if(['launch','terminate'].includes(page))return role==='admin'||role==='editor';
  return ['database','attachments','export','countries','account','documents','notifications'].includes(page);
}
