/*
test_strategy:
  artifact: admin UpgradeBattlesPanel
  rationale: Settings conversion, async errors and persisted match rendering need regression coverage.
  criticality: MEDIUM
  selected_types:
    - rationale: Validate numeric boundaries and stale-response state transitions.
      type: unit
      size: medium
      framework: node:test
      dependencies: [filesystem loader, request adapter]
      gate: Gate 1
    - rationale: Exercise actual render callbacks and controls; override admin-only Gate 3 skip for mutable RTP form.
      type: component
      size: medium
      framework: node:test
      dependencies: [VNode adapter, request adapter]
      gate: Gate 3
  rejected_types:
    - reason: Real provider/SQLite coverage owned by backend task (Gate 2).
      type: integration
    - reason: Coupled deploy, provided DTO is exercised directly (Gate 4).
      type: contract
    - reason: No production writes or deployment in UI task (Gate 5).
      type: smoke
    - reason: Finite boundary partitions sufficient (Gate 6).
      type: property-based
    - reason: Internal admin screen; no browser environment required for callback checks.
      type: e2e
  deliberately_skipped:
    - why: Scoped task excludes real settings mutations.
      what: Production save smoke
Gate 0 OFF: stateful UI. AC1 tabs preserve cases; AC2 validated config save;
AC3 failures/pending states; AC4 active/history lists; AC5 frozen rounds/proof/payouts.
*/
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const dir=path.join(__dirname,'../admin.titanrust.ru/public/assets');
function load(){
 const file=path.join(dir,'UpgradeBattlesPanel.js');
 assert.ok(fs.existsSync(file),'UpgradeBattlesPanel must exist');
 const code=fs.readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
 const context={ref:value=>({value}),defineComponent:v=>v,h:(tag,props,children)=>({tag,props:props||{},children}),onMounted:()=>{},onUnmounted:()=>{},request:async()=>{},console};
 vm.createContext(context);vm.runInContext(code+'\nthis.api={createAdminBattleModel,UpgradeBattlesPanel,withUpgradeBattles,configPayload};',context);return context.api;
}
const conf={enabled:false,rtp:.95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900};
const form={enabled:false,rtpPercent:95,minRoundBet:1,maxRoundBet:10000,waitSeconds:900};
const battle={uid:'room-1',status:'finished',roundBet:100,entryPrice:300,rtp:.95,pot:1500,
 createdAt:'2026-09-04T10:00:00Z',expiresAt:'2026-09-04T10:15:00Z',finishedAt:'2026-09-04T10:01:00Z',cancelReason:null,serverHash:'commit-hash',serverSeed:'revealed-seed',winnerUserIds:[1],
 targets:[0,1,2].map(i=>({id:i+1,name:'Skin '+i,price:500,chance:.19,image:'/item.png',rarity:'RARE'})),
 players:[{userId:1,name:'Alice',slot:0,clientSeed:'alice-seed',score:1000,payout:1500},{userId:2,name:'Bob',slot:1,clientSeed:'bob-seed',score:500,payout:0}],
 rounds:[0,1,2].flatMap(roundIndex=>[0,1].map(slot=>({roundIndex,slot,roll:.125,won:slot===0,value:slot===0?500:0})))};
function nodes(node){if(!node||typeof node!=='object')return[];return[node,...(Array.isArray(node.children)?node.children.flatMap(nodes):nodes(node.children))];}
function textOf(n){return typeof n==='string'||typeof n==='number'?String(n):Array.isArray(n)?n.map(textOf).join(' '):n?textOf(n.tag==='textarea'?n.props.value:n.children):'';}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};}
test('AC1 wrapper keeps original case component as initial view',()=>{const api=load(),Case={name:'Original'};const render=api.withUpgradeBattles(Case).setup();assert.ok(nodes(render()).some(n=>n.tag===Case));const tab=nodes(render()).find(n=>textOf(n)==='На апгрейдах');tab.props.onClick();assert.ok(nodes(render()).some(n=>n.tag===api.UpgradeBattlesPanel));});
test('AC1 compiled page exports wrapped original page',()=>{const s=fs.readFileSync(path.join(dir,'BattlesListPage-C95vn4AY.js'),'utf8');assert.match(s,/withUpgradeBattles\(Rt\)/);assert.match(s,/__name:"BattlesListPage"/);});
test('AC2 config roundtrip preserves disabled mode',async()=>{const calls=[];const m=load().createAdminBattleModel(async q=>{calls.push(q);return{success:true,data:conf};});await m.loadConfig();assert.equal(m.state.value.form.rtpPercent,95);await m.saveConfig();assert.equal(calls[1].method,'PUT');assert.equal(calls[1].url,'/upgrade-battles/config');assert.deepEqual(JSON.parse(JSON.stringify(calls[1].data)),conf);});
for(const [field,value,ok] of [['rtpPercent',.99,false],['rtpPercent',1,true],['rtpPercent',1.01,true],['rtpPercent',99.99,true],['rtpPercent',100,true],['rtpPercent',100.01,false],['minRoundBet',0,false],['minRoundBet',.01,true],['minRoundBet',.02,true],['maxRoundBet',9999.99,true],['maxRoundBet',10000,true],['maxRoundBet',10000.01,false],['waitSeconds',29,false],['waitSeconds',30,true],['waitSeconds',31,true],['waitSeconds',86399,true],['waitSeconds',86400,true],['waitSeconds',86401,false],['waitSeconds',30.5,false],['rtpPercent','',false],['minRoundBet',1.001,false]]){
 test(`AC2 ${field}=${value} ${ok?'accepted':'rejected'}`,()=>{const convert=()=>load().configPayload({...form,[field]:value});if(ok)assert.doesNotThrow(convert);else assert.throws(convert);});
}
test('AC2 reversed amount bounds rejected',()=>assert.throws(()=>load().configPayload({...form,minRoundBet:5,maxRoundBet:4})));
test('AC3 duplicate save blocked while pending',async()=>{const d=deferred();let calls=0;const m=load().createAdminBattleModel(()=>{calls++;return d.promise;});m.state.value.form={...form};const pending=m.saveConfig();assert.equal(m.state.value.saving,true);await m.saveConfig();assert.equal(calls,1);d.resolve({success:true,data:conf});await pending;assert.equal(m.state.value.saving,false);});
test('AC3 403 remains visible without success notice',async()=>{const m=load().createAdminBattleModel(async()=>{throw{response:{status:403,data:{message:'Только чтение'}}};});m.state.value.form={...form};await m.saveConfig();assert.match(m.state.value.configError,/Только чтение/);assert.equal(m.state.value.notice,'');assert.equal(m.state.value.saving,false);});
test('AC3 catch-all response is not an empty history',async()=>{const m=load().createAdminBattleModel(async()=>({success:true,catchAll:true,data:[]}));await m.loadList();assert.ok(m.state.value.listError);assert.equal(m.state.value.battles,null);});
test('AC4 history filter sent explicitly',async()=>{let q;const m=load().createAdminBattleModel(async x=>{q=x;return{success:true,data:{battles:[battle],config:conf}}});await m.loadList(true);assert.equal(q.params.history,true);assert.equal(m.state.value.battles[0].entryPrice,300);});
test('AC4 older list request cannot overwrite new filter',async()=>{const d=deferred();const m=load().createAdminBattleModel(q=>q.params.history?Promise.resolve({data:{battles:[battle],config:conf}}):d.promise);const first=m.loadList(false);await m.loadList(true);d.resolve({data:{battles:[],config:conf}});await first;assert.equal(m.state.value.battles[0].uid,'room-1');});
test('AC5 detail is GET-only and URI encoded',async()=>{let q;const m=load().createAdminBattleModel(async x=>{q=x;return{success:true,data:{battle}}});await m.openBattle('a/b');assert.equal(q.method,'GET');assert.equal(q.url,'/upgrade-battles/a%2Fb');assert.equal(m.state.value.battle.serverSeed,'revealed-seed');});
test('AC5 closing details ignores late response',async()=>{const d=deferred(),m=load().createAdminBattleModel(()=>d.promise);const p=m.openBattle('room-1');m.closeBattle();d.resolve({data:{battle}});await p;assert.equal(m.state.value.battle,null);assert.equal(m.state.value.selectedUid,null);});
test('AC5 rendered details expose three rounds and saved payouts',()=>{const api=load(),m=api.createAdminBattleModel(async()=>{});m.state.value.form={...form};m.state.value.battle=battle;m.state.value.selectedUid=battle.uid;const render=api.UpgradeBattlesPanel.setup({model:m});const text=textOf(render());for(const value of ['Skin 0','Skin 1','Skin 2','Alice','Bob','revealed-seed','commit-hash','alice-seed','95','Выплата'])assert.ok(text.includes(value),value);assert.equal(nodes(render()).filter(n=>n.props['data-round']!==undefined).length,3);});
test('AC3 form controls disabled during save',()=>{const api=load(),m=api.createAdminBattleModel(async()=>{});m.state.value.form={...form};m.state.value.saving=true;const n=api.UpgradeBattlesPanel.setup({model:m})();assert.ok(nodes(n).find(x=>x.tag==='fieldset').props.disabled);assert.ok(nodes(n).find(x=>x.tag==='button'&&x.props.type==='submit').props.disabled);});
test('AC1 styles do not recolor original case page buttons',()=>{const css=fs.readFileSync(path.join(dir,'UpgradeBattlesPanel.css'),'utf8');assert.doesNotMatch(css,/\.aub-page button/);});
test('AC5 waiting match cannot reveal a mistakenly supplied seed',()=>{const api=load(),m=api.createAdminBattleModel(async()=>{});m.state.value.battle={...battle,status:'waiting'};m.state.value.selectedUid=battle.uid;const text=textOf(api.UpgradeBattlesPanel.setup({model:m})());assert.ok(!text.includes('revealed-seed'));assert.ok(text.includes('Будет раскрыт'));});
test('AC3 disposed panel ignores config response',async()=>{const d=deferred(),m=load().createAdminBattleModel(()=>d.promise);const p=m.loadConfig();m.dispose();d.resolve({data:conf});await p;assert.equal(m.state.value.form,null);});
test('AC3 failed detail remains visible with refresh action',async()=>{const api=load(),m=api.createAdminBattleModel(async()=>{throw Error('offline')});await m.openBattle('room-1');const tree=api.UpgradeBattlesPanel.setup({model:m})();assert.match(textOf(tree),/offline/);assert.ok(nodes(tree).some(n=>n.tag==='button'&&textOf(n)==='Обновить матч'));});
test('AC4 native createVNode receives arrays for nested table nodes',()=>{const api=load(),m=api.createAdminBattleModel(async()=>{});m.state.value.battles=[];const tree=api.UpgradeBattlesPanel.setup({model:m})();for(const n of nodes(tree))if(typeof n.tag==='string')assert.ok(!n.children||typeof n.children!=='object'||Array.isArray(n.children),'Invalid children for '+n.tag);});
