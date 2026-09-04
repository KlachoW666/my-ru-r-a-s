/*
test_strategy:
  artifact: upgrade-battle-page.js
  rationale: Paid-entry UI must keep retry identity and render saved results without POST on reload.
  criticality: HIGH
  selected_types:
    - rationale: Validate amount boundaries, request snapshots and state transitions.
      type: unit
      size: medium
      framework: node:test
      dependencies: [filesystem module loader, isolated request adapter]
      gate: Gate 1
    - rationale: Exercise rendered controls and consumer envelopes without production traffic.
      type: component
      size: medium
      framework: node:test
      dependencies: [VNode adapter, isolated request adapter]
      gate: Gate 3
  rejected_types:
    - reason: Provider and real money integration belongs to service task.
      type: integration
    - reason: Coupled deployment; consumer examples cover provided contract.
      type: contract
    - reason: No deployed backend in this frontend-only task.
      type: smoke
    - reason: Bounded cases use boundary tables instead of fuzzing.
      type: property-based
    - reason: Real browser/backend acceptance remains main-task integration.
      type: e2e
  deliberately_skipped:
    - why: No server or real-money authority in task C.
      what: Production create/join calls
AC: two modes; exact 3 targets; paid confirmation; stable retry; saved room GET-only;
401 visible; stale search ignored; disposal stops polling; failures are not empty rooms.
*/
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const file=path.join(__dirname,'../public/assets/js/upgrade-battle-page.js');
function load(overrides={}){
  assert.ok(fs.existsSync(file),'public upgrade battle module must exist');
  const code=fs.readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
  const context={URLSearchParams,URL,console,setTimeout,clearTimeout,setInterval,clearInterval,
    ref:value=>({value}),defineComponent:x=>x,h:(tag,props,children)=>({tag,props:props||{},children}),
    onMounted:()=>{},onUnmounted:()=>{},useUserStore:()=>({fetchUserData:async()=>{}}),useAuthStore:()=>({isAuthenticated:true}),
    crypto:require('node:crypto').webcrypto,request:async()=>{},document:{getElementById:()=>true},
    window:{location:{search:'?mode=upgrade',assign:()=>{}}},...overrides};
  vm.createContext(context);
  vm.runInContext(code+'\nthis.api={createBattleModel,withBattleModes,UpgradeBattlePage};',context);
  return context.api;
}
const config={enabled:true,rtp:.95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900};
const targets=[1,2,3].map(id=>({id,name:'Skin '+id,price:500,image:'/skin.png',rarity:'RARE',chance:.19}));
function room(status='waiting'){return{uid:'room-1',status,roundBet:100,entryPrice:300,rtp:.95,createdAt:'2026-09-03T00:00:00Z',expiresAt:'2099-09-03T00:15:00Z',finishedAt:null,serverHash:'abc',serverSeed:status==='finished'?'seed':null,targets,players:[{userId:1,name:'Alice',avatar:'',slot:0,score:500,payout:1000,clientSeed:'client'}],rounds:status==='finished'?[{roundIndex:0,slot:0,roll:.1,won:true,value:500}]:[],pot:1000,winnerUserIds:[1],viewerIsCreator:true,viewerIsPlayer:true};}
function setup(send,search=''){
 const model=load().createBattleModel({request:send,uuid:()=> 'stable-uuid',navigate:()=>{},refreshBalance:async()=>{},search});
 model.state.value.config=config;model.state.value.selected=targets.slice();
 return model;
}
test('wrapper preserves case lobby',()=>{const api=load(),Case={name:'Case'};const render=api.withBattleModes(Case).setup();const node=render();assert.equal(node.children[1].tag,api.UpgradeBattlePage);});
test('create requires confirmation before POST',async()=>{const calls=[];const m=setup(async q=>{calls.push(q);return{status:'success',data:{battle:room()}}});m.prepareCreate();assert.equal(calls.length,0);assert.equal(m.state.value.confirmation.price,300);await m.confirm();assert.equal(calls[0].url,'/upgrade-battles/create');assert.equal(calls[0].data.targetIds.length,3);});
test('create retry preserves complete request payload',async()=>{const calls=[];const m=setup(async q=>{calls.push(JSON.stringify(q.data));throw Error('offline')});m.prepareCreate();await m.confirm();assert.match(m.state.value.error,/offline/);await m.confirm();assert.equal(calls[0],calls[1]);assert.equal(m.state.value.confirmation.payload.requestId,'stable-uuid');});
test('failed create cannot be silently edited',async()=>{const m=setup(async()=>{throw Error('offline')});m.prepareCreate();await m.confirm();assert.equal(m.formLocked(),true);m.newForm();assert.equal(m.formLocked(),false);});
for(const [amount,valid] of [[.99,false],[1,true],[1.01,true],[9999.99,true],[10000,true],[10000.01,false],[NaN,false],[Infinity,false]]){
 test('round amount boundary '+amount,()=>{const m=setup(async()=>{});m.state.value.roundBet=amount;m.state.value.selected=targets.map(x=>({...x,price:amount*5}));m.prepareCreate();assert.equal(!!m.state.value.confirmation,valid);});
}
test('exactly three targets required',()=>{for(const count of [2,3,4]){const m=setup(async()=>{});m.state.value.selected=Array.from({length:count},(_,i)=>({...targets[0],id:i+1}));m.prepareCreate();assert.equal(!!m.state.value.confirmation,count===3);}});

test('targets outside real server chance bounds are rejected',()=>{for(const price of [100,9500.01,0,NaN]){const m=setup(async()=>{});m.state.value.selected=targets.map(x=>({...x,price}));m.prepareCreate();assert.equal(m.state.value.confirmation,null);assert.ok(m.state.value.error);}});

test('fractional kopecks are rejected',()=>{const m=setup(async()=>{});m.state.value.roundBet=100.001;m.prepareCreate();assert.equal(m.state.value.confirmation,null);});

test('cancel requires creator permission',()=>{const m=setup(async()=>{});m.state.value.battle={...room(),viewerIsCreator:false};m.prepareCancel();assert.equal(m.state.value.confirmation,null);});

test('malformed room cannot become a blank screen',async()=>{const m=setup(async()=>({status:'success',data:{battle:{uid:'room-1'}}}),'?mode=upgrade&battle=room-1');await m.load();assert.ok(m.state.value.error);assert.equal(m.state.value.battle,null);m.dispose();});
test('disabled mode blocks create',()=>{const m=setup(async()=>{});m.state.value.config={...config,enabled:false};m.prepareCreate();assert.equal(m.state.value.confirmation,null);});
test('finished permalink performs GET only',async()=>{const calls=[];const m=setup(async q=>{calls.push(q);return{status:'success',data:{battle:room('finished')}}},'?mode=upgrade&battle=room-1');await m.load();assert.equal(m.state.value.battle.status,'finished');assert.equal(m.state.value.visibleRounds,3);assert.ok(calls.every(x=>x.method==='GET'));m.dispose();});
test('guest failures explain login',async()=>{const m=setup(async()=>{throw{response:{status:401,data:{message:'Unauthorized'}}}});await m.load();assert.match(m.state.value.error,/войти/i);});
test('invalid success envelope is a visible error',async()=>{const m=setup(async()=>({status:'success',data:[]}));await m.load();assert.ok(m.state.value.error);});
test('search sends name plus numeric price filters',async()=>{let sent;const m=setup(async q=>{sent=q;return{status:'success',data:{items:targets,total:3}}});Object.assign(m.state.value,{searchText:'MP5',minPrice:'10000',maxPrice:'20000'});await m.searchItems();assert.equal(sent.params.search,'MP5');assert.equal(sent.params.minPrice,10000);assert.equal(sent.params.maxPrice,20000);});
test('stale search cannot replace newer results',async()=>{const pending=[];const m=setup(()=>new Promise(resolve=>pending.push(resolve)));const first=m.searchItems();const second=m.searchItems();pending[1]({status:'success',data:{items:[targets[1]],total:1}});await second;pending[0]({status:'success',data:{items:[targets[0]],total:1}});await first;assert.equal(m.state.value.items[0].id,2);});
test('join confirmation uses frozen room entry price',async()=>{let sent;const m=setup(async q=>{sent=q;return{status:'success',data:{battle:room('finished')}}});m.state.value.battle={...room(),viewerIsPlayer:false,viewerIsCreator:false};m.prepareJoin();assert.equal(m.state.value.confirmation.price,300);await m.confirm();assert.equal(sent.url,'/upgrade-battles/room-1/join');assert.equal(sent.data.clientSeed,'stable-uuid');m.dispose();});
test('creator cannot join own room',()=>{const m=setup(async()=>{});m.state.value.battle=room();m.prepareJoin();assert.equal(m.state.value.confirmation,null);});
test('lobby bundle uses wrapper default export',()=>{const s=fs.readFileSync(path.join(__dirname,'../public/assets/js/BattleLobbyPage-BSXGeKDe.js'),'utf8');assert.match(s,/withBattleModes/);assert.match(s,/export\{UpgradeBattleModes as default\}/);});

test('public navigation consistently calls the section battles',()=>{
 const files=['index-CyyoIbm1.js','BattleLobbyPage-BSXGeKDe.js','BattleGamePage-6ZhqY5fR.js'];
 const source=files.map(name=>fs.readFileSync(path.join(__dirname,'../public/assets/js',name),'utf8')).join('\n');
 assert.match(source,/"nav\.battle":"Батлы"/);
 assert.doesNotMatch(source,/Замес|замес/);
});

test('router case switch does not block upgrade lobby',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../public/assets/js/index-CyyoIbm1.js'),'utf8');
 const expression=source.match(/return (s\.startsWith\("\/crate-pvp"\).*?)\?o\(\{name:"home"\}\)/)[1];
 const blocked=(route)=>vm.runInNewContext(expression,{s:route.path,e:route,i:{isBattleEnabled:false}});
 assert.equal(blocked({path:'/crate-pvp',query:{mode:'upgrade'}}),false);
 assert.equal(blocked({path:'/crate-pvp',query:{}}),true);
 assert.equal(blocked({path:'/crate-pvp/existing-case-battle',query:{mode:'upgrade'}}),true);
});

function realVue(){
 const source=fs.readFileSync(path.join(__dirname,'../public/assets/js/vendor-vNcy1sFx.js'),'utf8')
   .replace(/export\{([^}]+)\};?\s*$/,(_,exports)=>'this.vue={'+exports.split(',').map(entry=>{const [local,key]=entry.trim().split(' as ');return JSON.stringify(key||local)+':'+local}).join(',')+'};');
 const context={console,HTMLElement:class{},customElements:{get:()=>true,define:()=>{}},setTimeout,clearTimeout,Intl,URL,URLSearchParams};
 vm.runInNewContext(source,context);return context.vue;
}
const walk=node=>!node||typeof node!=='object'?[]:[node,...(Array.isArray(node.children)?node.children.flatMap(walk):[])];
const label=node=>typeof node?.children==='string'?node.children:'';

test('real bundled Vue renders both mode links',()=>{
 const vue=realVue();const api=load({defineComponent:vue.a,ref:vue.r,h:vue.s});
 const Case={name:'ExistingCaseLobby'};
 const upgrade=api.withBattleModes(Case).setup()();
 assert.equal(upgrade.children[1].type,api.UpgradeBattlePage);
 assert.deepEqual(walk(upgrade).filter(x=>x.type==='a').map(label),['На кейсах','На апгрейдах']);
 const caseApi=load({defineComponent:vue.a,ref:vue.r,h:vue.s,window:{location:{search:''}}});
 assert.equal(caseApi.withBattleModes(Case).setup()().children[1].type,Case);
});

test('rendered create controls require explicit paid confirmation',async()=>{
 const vue=realVue(),mounts=[],unmounts=[],calls=[];
 const api=load({defineComponent:vue.a,ref:vue.r,h:vue.s,onMounted:fn=>mounts.push(fn),onUnmounted:fn=>unmounts.push(fn),
   request:async q=>{calls.push(q);return{status:'success',data:q.url.endsWith('/items')?{items:targets,total:3}:{battles:[],config}};}});
 const render=api.UpgradeBattlePage.setup();mounts.forEach(fn=>fn());
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 let nodes=walk(render());const form=nodes.find(x=>x.type==='form');assert.ok(form);
 form.props.onSubmit({preventDefault(){}});
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 nodes=walk(render());nodes.filter(x=>x.type==='button'&&x.props.class==='ub-item').forEach(x=>x.props.onClick());
 nodes=walk(render());const create=nodes.find(x=>x.type==='button'&&label(x)==='Создать батл');
 assert.equal(create.props.disabled,false);create.props.onClick();
 assert.ok(walk(render()).some(x=>x.type==='button'&&label(x)==='Подтвердить'));
 assert.ok(calls.every(x=>x.method==='GET'));
 unmounts.forEach(fn=>fn());
});

test('waiting room polls at 3 seconds then stops on disposal',async()=>{
 const scheduled=new Map();let next=0,calls=0;
 const api=load({setTimeout:(fn,ms)=>{scheduled.set(++next,{fn,ms});return next;},clearTimeout:id=>scheduled.delete(id)});
 const m=api.createBattleModel({search:'?mode=upgrade&battle=room-1',request:async()=>{calls++;return{status:'success',data:{battle:room()}}}});
 await m.load();assert.equal(calls,1);
 const poll=[...scheduled.values()].find(t=>t.ms===3000);assert.ok(poll);
 await poll.fn();assert.equal(calls,2);
 m.dispose();assert.equal(scheduled.size,0);
});

test('failed paid request keeps its visible error until explicit retry',async()=>{
 const scheduled=new Map();let next=0;
 const api=load({setTimeout:(fn,ms)=>{scheduled.set(++next,{fn,ms});return next;},clearTimeout:id=>scheduled.delete(id)});
 const m=api.createBattleModel({uuid:()=> 'stable-uuid',search:'',request:async()=>{throw Error('offline');}});
 Object.assign(m.state.value,{config,selected:targets});
 m.prepareCreate();await m.confirm();
 assert.equal([...scheduled.values()].some(t=>t.ms===3000),false);
 assert.match(m.state.value.error,/offline/);m.dispose();
});

test('permalink update preserves Vue Router history state',async()=>{
 let updated;
 const api=load({window:{location:{search:''},history:{state:{back:'/cases',current:'/crate-pvp?mode=upgrade',position:2},replaceState:(state,_,url)=>{updated={state,url};}}}});
 const m=api.createBattleModel({uuid:()=> 'stable-uuid',request:async()=>({status:'success',data:{battle:room()}})});
 Object.assign(m.state.value,{config,selected:targets});m.prepareCreate();await m.confirm();
 assert.equal(updated.state.back,'/cases');assert.equal(updated.state.position,2);assert.match(updated.url,/battle=room-1/);m.dispose();
});
