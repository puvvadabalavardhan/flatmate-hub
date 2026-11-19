let user=null; const cbs=[]; const auth={};
const mk=g=>({uid:g.uid,email:g.email,displayName:g.name||'',emailVerified:g.verified!==false,
  reload:async function(){ if(window.__verified&&window.__verified[this.email]) this.emailVerified=true; }, getIdToken:async()=>'tok'});
function setUser(u){ user=u; auth.currentUser=u; window.__curEmail=u?u.email:null; cbs.forEach(cb=>cb(u)); }
export function getAuth(){ return auth; }
export function onAuthStateChanged(a,cb){ cbs.push(cb); setTimeout(()=>{ if(window.__fbAuto && !user){ user=mk(window.__fbAuto); auth.currentUser=user; window.__curEmail=user.email; } cb(user); },20); return ()=>{}; }
export class GoogleAuthProvider{ setCustomParameters(){} }
const E=c=>{const e=new Error(c);e.code=c;return e;};
export async function signInWithPopup(){ if(!window.__fbGoogle) throw E('auth/popup-closed-by-user'); setUser(mk(window.__fbGoogle)); return {user}; }
export async function signInWithRedirect(){ }
export async function getRedirectResult(){ return null; }
export async function signInWithEmailAndPassword(a,e,p){ const acc=(window.__accts||{})[e]; if(!acc||acc.p!==p) throw E('auth/invalid-credential'); setUser(mk({uid:acc.uid,email:e,verified:acc.v})); return {user}; }
export async function createUserWithEmailAndPassword(a,e,p){ if(p.length<6) throw E('auth/weak-password'); window.__accts=window.__accts||{}; if(window.__accts[e]) throw E('auth/email-already-in-use'); const uid='em'+Math.random().toString(36).slice(2,10); window.__accts[e]={p,uid,v:false}; const u=mk({uid,email:e,verified:false}); setUser(u); return {user:u}; }
export async function sendEmailVerification(u){ window.__verifySent=u.email; }
export async function sendPasswordResetEmail(a,e){ window.__resetSent=e; }
export async function signOut(){ setUser(null); }
