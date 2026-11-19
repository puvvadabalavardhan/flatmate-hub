const subs=new Set(); window.__refresh=()=>subs.forEach(f=>f());
const E=(c,m)=>{const e=new Error(m||c);e.code=c;return e;};
export function initializeFirestore(app,opts){ window.__fsOpts=opts; return {app}; }
export const getFirestore=a=>({app:a});
export const persistentLocalCache=()=>({}); export const persistentMultipleTabManager=()=>({});
export function collection(fs,path){ if(path.split('/').length%2!==1) throw E('invalid-argument','collection path parity '+path); return {type:'col',path}; }
export function doc(a,path){ if(a&&a.type==='col'){const id='f'+Math.random().toString(36).slice(2,14);return {type:'doc',path:a.path+'/'+id,id};}
  if(path.split('/').length%2!==0) throw E('invalid-argument','doc path parity '+path); return {type:'doc',path,id:path.split('/').pop()}; }
export const where=(f,op,v)=>({t:'where',f,op,v}); export const orderBy=(f,d)=>({t:'order',f,d}); export const limit=n=>({t:'limit',n});
export function query(c,...cons){ return {type:'query',col:c.path,cons}; }
function spec(q){ if(q.type==='col') return {col:q.path,where:[]}; const s={col:q.col,where:[]};
  for(const c of q.cons){ if(c.t==='where') s.where.push([c.f,c.op,c.v]); if(c.t==='order') s.order=[c.f,c.d]; if(c.t==='limit') s.limit=c.n; }
  // Emulate Firestore index requirements (single-field indexes only, no composite indexes configured)
  const RANGE=['<','<=','>','>=','!=','not-in'], EQ=['==','in','array-contains'];
  const rf=[...new Set(s.where.filter(w=>RANGE.includes(w[1])).map(w=>w[0]))], ef=s.where.filter(w=>EQ.includes(w[1])).map(w=>w[0]);
  const need = rf.length>1 || (ef.length && rf.length) || (s.order && ef.length && !ef.includes(s.order[0])) || (s.order && rf.length && rf[0]!==s.order[0]);
  if(need) throw E('failed-precondition','The query requires an index: '+JSON.stringify(s));
  return s; }
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const ds=(id,r)=>({id,exists:()=>!!r.exists,data:()=>r.exists?clone(r.data):undefined,metadata:{fromCache:false,hasPendingWrites:false}});
function checkData(d){ (function walk(o){ for(const k in o){ if(o[k]===undefined && !(window.__fsOpts&&window.__fsOpts.ignoreUndefinedProperties)) throw E('invalid-argument','undefined field '+k); if(o[k]&&typeof o[k]==='object') walk(o[k]); } })(d); }
export async function getDoc(r){ if(r.path.startsWith('allow/') && window.__curEmail!==window.__ADMIN && r.path!=='allow/'+window.__curEmail) throw E('permission-denied','no'); return ds(r.id, await window.__db('get',{path:r.path})); }
export async function getDocs(q){ if((q.col||q.path)==='allow' && window.__curEmail!==window.__ADMIN) throw E('permission-denied','Missing or insufficient permissions.'); const docs=await window.__db('query',spec(q)); return {docs:docs.map(d=>ds(d.id,{exists:true,data:d.data})),metadata:{fromCache:false}}; }
export async function setDoc(r,data,opts){ checkData(data); let d=clone(data); if(opts&&opts.merge){ const cur=await window.__db('get',{path:r.path}); d={...(cur.exists?cur.data:{}),...d}; } await window.__db('set',{path:r.path,data:d}); }
export async function updateDoc(r,data){ checkData(data); const cur=await window.__db('get',{path:r.path}); if(!cur.exists) throw E('not-found','No document to update'); await window.__db('set',{path:r.path,data:{...cur.data,...clone(data)}}); }
export async function deleteDoc(r){ await window.__db('delete',{path:r.path}); }
export function onSnapshot(target,a,b,c){ let next,err; if(typeof a==='function'){next=a;err=b;}else{next=b;err=c;}
  let q; try{ q=target.type==='doc'?null:spec(target); }catch(e){ setTimeout(()=>err&&err(e),0); return ()=>{}; }
  const run=async()=>{ try{ next(target.type==='doc'?await getDoc(target):await getDocs(target)); }catch(e){ err&&err(e); } };
  subs.add(run); run(); return ()=>subs.delete(run); }
export async function runTransaction(fs,fn){ const ops=[]; const tx={get:getDoc,set:(r,d,o)=>{ops.push(()=>setDoc(r,d,o));return tx;}}; const res=await fn(tx); for(const op of ops) await op(); return res; }
