'use strict';
/* test_strategy:
 * artifact: CaseRewards result controls
 * rationale: Gate 0 OFF; explicit sale is a money-moving user action.
 * criticality: HIGH
 * selected_types:
 *   - rationale: Evaluate actual render and click callbacks with a narrow Vue VNode adapter.
 *     type: component
 *     size: medium
 *     framework: node:test
 *     dependencies: [filesystem, vm, Vue VNode adapter, request stub]
 *     gate: Gate 3
 * rejected_types:
 *   - reason: Gates 1 and 2 covered by component and real SQLite suite respectively.
 *     type: unit
 *   - reason: Gate 4 same deployment; request payload checked here.
 *     type: contract
 *   - reason: Gate 5 no deployed mutations permitted.
 *     type: smoke
 *   - reason: Gate 6 finite states are enumerated.
 *     type: property-based
 * deliberately_skipped:
 *   - why: Real money is outside test scope.
 *     what: Live opening E2E
 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.join(__dirname,'../public/assets/js/CaseRewards.js');
function component(result,request){
  assert.ok(fs.existsSync(file),'Case rewards component exists');
  let source=fs.readFileSync(file,'utf8').replace(/^import .*;\r?\n/gm,'').replace('export default','const component =');
  const exports=vm.runInNewContext(source+';component',{defineComponent:x=>x,ref:x=>({value:x}),h:(tag,props,children)=>({tag,props,children}),request,Intl});
  const events=[];const render=exports.setup({result},{emit:(...args)=>events.push(args)});return {render,events};
}
function nodes(v){return [v,...(Array.isArray(v?.children)?v.children.flatMap(nodes):[])];}
test('inventory message explains destination before sale',()=>{const c=component({rewardDestination:'inventory',inventoryIds:[10],winnings:1943,sellFeePercent:0},()=>{});assert.match(JSON.stringify(c.render()),/инвентарь/);assert.match(JSON.stringify(c.render()),/Баланс/);});
test('sale sends only won inventory ids',async()=>{let calls=0;const c=component({rewardDestination:'inventory',inventoryIds:[10,11],winnings:1943,sellFeePercent:0},async req=>{calls++;assert.equal(req.url,'/inventory/sell');assert.deepEqual(Array.from(req.data.ids),[10,11]);return {status:'success',data:{payout:1943,balance:35378.04}};});const b=nodes(c.render()).find(x=>x.tag==='button');await b.props.onClick();await b.props.onClick();assert.equal(calls,1);assert.match(JSON.stringify(c.render()),/Продано/);assert.equal(c.events.length,1);});
test('server sale failure remains visible without claiming success',async()=>{const c=component({rewardDestination:'inventory',inventoryIds:[10],winnings:330},async()=>{throw new Error('test offline');});await nodes(c.render()).find(x=>x.tag==='button').props.onClick();assert.match(JSON.stringify(c.render()),/Не удалось/);assert.equal(c.events.length,0);});
test('auto-sold response has no sale button',()=>{const c=component({rewardDestination:'balance',inventoryIds:[10],winnings:330},()=>{});assert.equal(nodes(c.render()).filter(x=>x.tag==='button').length,0);assert.match(JSON.stringify(c.render()),/баланс/);});
