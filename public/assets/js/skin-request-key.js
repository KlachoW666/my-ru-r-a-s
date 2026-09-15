// Keep the same key after a lost response, including a page reload.
const pending=new Map();
export function skinRequestKey(userId,items){
  const storageKey=`bearz:skin-request:${userId}`;
  const selection=JSON.stringify([...items].sort((a,b)=>a.name.localeCompare(b.name)));
  let current=pending.get(storageKey);
  try{current=JSON.parse(sessionStorage.getItem(storageKey))||current;}catch{}
  if(!current||current.selection!==selection)current={selection,key:crypto.randomUUID()};
  pending.set(storageKey,current);
  try{sessionStorage.setItem(storageKey,JSON.stringify(current));}catch{}
  return current.key;
}
export function clearSkinRequestKey(userId){
  const storageKey=`bearz:skin-request:${userId}`;
  pending.delete(storageKey);
  try{sessionStorage.removeItem(storageKey);}catch{}
}
