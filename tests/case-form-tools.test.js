'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const bundle=path.resolve(__dirname,'../admin.titanrust.ru/public/assets/CaseFormModal.vue_vue_type_script_setup_true_lang-84FjkQIS.js');
const helper=path.resolve(__dirname,'../admin.titanrust.ru/public/assets/case-form-tools.mjs');
/*
test_strategy:
  artifact: compiled case form search and auto RTP
  rationale: Numeric search becomes a name search; old solver reports success on unreachable targets.
  criticality: HIGH
  selected_types:
    - rationale: Execute the actual button handler and query builder extracted from the shipped bundle (Gate 0 OFF).
      type: unit
      size: small
      framework: node:test
      dependencies: [node:vm]
      gate: Gate 1
    - rationale: Repeated price sets must conserve tickets and probabilities.
      type: property-based
      size: small
      framework: node:test deterministic parameter sweep
      dependencies: []
      gate: Gate 6
  rejected_types:
    - reason: SQL boundaries covered in content-contract.test.js (Gate 2).
      type: integration
    - reason: No Vue component sources; internal admin UI (Gate 3).
      type: component
    - reason: Consumer and provider ship together (Gate 4).
      type: contract
  deliberately_skipped:
    - why: Requires login on published admin; no deployment performed.
      what: Production browser smoke (Gate 5).
Test Cases to Cover:
- [unit] AC1 numeric input, comparisons, name+price, MP5 name and blank search.
- [unit] AC2 price zero, empty composition, impossible target do not change chances.
- [unit] AC3 targets above uniform EV work; actual saved tickets agree with chances.
- [property-based] AC4 normalized nonnegative ticket widths over varied feasible price sets.
*/
async function tools(){return fs.existsSync(helper)?import(pathToFileURL(helper)):{};}
async function search(value){
  const s=fs.readFileSync(bundle,'utf8'),start=s.indexOf('const It=p(')+11,end=s.indexOf('),{data:St',start);
  const fn=vm.runInNewContext('('+s.slice(start,end)+')',{K:{value},...await tools()});
  return JSON.parse(JSON.stringify(fn()));
}
for(const [input,expected]of [
  ['10000',{priceMin:10000,sortDir:'asc'}],['10 000',{priceMin:10000,sortDir:'asc'}],
  ['<10000',{priceLt:10000,sortDir:'desc'}],['<=10000',{priceMax:10000,sortDir:'desc'}],
  ['>10000',{priceGt:10000,sortDir:'asc'}],['MP5',{name:'MP5'}],['AK >=10000 <20000',{name:'AK',priceMin:10000,priceLt:20000}],
  ['9,95',{priceMin:9.95}],['',{ }]
])test('AC1 search '+JSON.stringify(input),async()=>{
  const q=await search(input);for(const [k,v]of Object.entries(expected))assert.equal(q[k],v);
  if(!expected.name)assert.equal(q.name,undefined);assert.equal(q.page,1);
});
async function auto(prices,casePrice){
  const s=fs.readFileSync(bundle,'utf8'),start=s.indexOf('function runAutoRtp()'),end=s.indexOf('function D()',start);
  const items=prices.map((price,id)=>({id,price,chance:0,ticketRangeFrom:0,ticketRangeTo:0}));
  const errors=[],successes=[];
  const context={c:{value:items},k:{value:casePrice},Re:{value:new Map()},de:{value:new Map()},Oe:1000000,
    _:{error:m=>errors.push(m),success:m=>successes.push(m)},D:()=>{},...await tools()};
  vm.runInNewContext(s.slice(start,end)+';runAutoRtp();',context);
  return {items:context.c.value,errors,successes};
}
for(const [prices,price]of [[[],100],[[10,90],0],[[100,200],50],[[10,20],100]])test('AC2 rejects '+JSON.stringify([prices,price]),async()=>{
  const result=await auto(prices,price);assert.equal(result.successes.length,0);assert.equal(result.errors.length,1);
  assert.ok(result.items.every(i=>i.chance===0));
});
test('AC3 target above uniform expected value is achievable',async()=>{
  const r=await auto([10,90],80);assert.equal(r.errors.length,0);assert.equal(r.successes.length,1);
  assert.ok(Math.abs(r.items.reduce((sum,i)=>sum+i.price*i.chance/100,0)/80-.96)<.00001);
});
test('AC4 ticket conservation across feasible distributions',async()=>{
  for(let n=2;n<=30;n++){
    const prices=Array.from({length:n},(_,i)=>1+i*i*7),price=(prices[0]+prices.at(-1))/.96/2;
    const r=await auto(prices,price);assert.equal(r.errors.length,0);
    let cursor=1,sum=0;
    for(const i of r.items){assert.equal(i.ticketRangeFrom,cursor);const width=i.ticketRangeTo-i.ticketRangeFrom+1;
      assert.ok(Number.isInteger(width)&&width>=0);assert.ok(Math.abs(i.chance-width/10000)<1e-9);cursor=i.ticketRangeTo+1;sum+=i.chance;}
    assert.equal(cursor,1000001);assert.ok(Math.abs(sum-100)<1e-9);
  }
});
