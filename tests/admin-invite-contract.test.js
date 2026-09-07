const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {makeAdminRoutes}=require('../admin.titanrust.ru/server/adminRoutes');
function fixture(role='SUPER_ADMIN'){
 const routes=new Map(), writes=[];
 const app=Object.fromEntries(['get','post','put','patch','delete'].map(method=>[method,(path,...handlers)=>routes.set(method+path,handlers.at(-1))]));
 makeAdminRoutes({app,requireAdminJWT:()=>{},dbAll:async()=>[],dbGet:async()=>null,dbRun:async(...args)=>{writes.push(args);return{changes:1,lastID:1}}});
 const req={user:{role,username:'test-owner'},body:{role:'ADMIN',hours:24},params:{id:1}};
 const res={code:200,status(n){this.code=n;return this},json(body){this.body=body;return this}};
 return{routes,writes,req,res};
}
test('invite creates a one-time token with the requested role and expiry',async()=>{
 const f=fixture();await f.routes.get('post/api/v1/admin/admins/invite')(f.req,f.res);
 assert.equal(f.res.code,200);assert.match(f.res.body.data.token,/^[A-Za-z0-9_-]{43}$/);
 assert.equal(f.writes.length,1);assert.equal(f.writes[0][1][1],'ADMIN');
 assert.ok(Date.parse(f.res.body.data.expiresAt)>Date.now());
});
test('ordinary administrator cannot issue a privileged invitation',async()=>{
 const f=fixture('ADMIN');f.req.body.role='SUPER_ADMIN';await f.routes.get('post/api/v1/admin/admins/invite')(f.req,f.res);
 assert.equal(f.res.code,403);assert.equal(f.writes.length,0);
});
test('revocation expires only an unused token and never suspends an account',async()=>{
 const f=fixture();await f.routes.get('post/api/v1/admin/admins/invites/:id/revoke')(f.req,f.res);
 assert.match(f.writes[0][0],/used_at IS NULL/);assert.equal(f.res.body.data.userSuspended,false);
});
test('invite page matches the existing passkey invitation API',()=>{
 const s=fs.readFileSync('admin.titanrust.ru/public/assets/InvitesPage-BHnKeJ_k.js','utf8');
 assert.ok(s.includes('E.post("/admins/invite",{role:M.value,hours:Number(N.value)})'));
 assert.ok(s.includes('_.value=n.data.token'));assert.ok(s.includes('role:"alert"'));
 assert.ok(!s.includes('E.post("/auth/invite"'));
});
