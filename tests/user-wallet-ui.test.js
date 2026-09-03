'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
// test_strategy: integration of the actual compiled callback (Gate 2), medium.
// Gate 0 OFF (payment mutation); Gate 1 covered here; Gate 3 browser E2E deferred
// until authenticated staging is available; Gate 4 same deploy; Gate 5 no real
// balance mutations; Gate 6 retry/idempotency invariant exercised deterministically.
test('AC8: wallet UI reuses its request ID after a network error',async()=>{
  const source=fs.readFileSync(require.resolve('../admin.titanrust.ru/public/assets/transactionReason-Caun9sQ9.js'),'utf8');
  const start=source.indexOf('async function M()'),end=source.indexOf('return(s,e)=>',start);
  const callback=source.slice(start,end);
  const requests=[];
  const context={crypto:require('node:crypto'),walletRequest:null,v:{value:false},x:{userId:'1'},
    r:{value:'10000'},a:{value:'CREDIT'},u:{value:'компенсация'},n:{value:'10'},f:{value:true},
    p:{success(){},error(){}},g(){},_:{mutateAsync:async request=>{
      requests.push(request);if(requests.length===1)throw new Error('Network lost');return {data:{newBalance:'10000.00'}};
    }}};
  const run=vm.runInNewContext('('+callback+')',context);
  await run();await run();
  assert.match(requests[0].data.requestId||'',/^[a-f0-9-]{36}$/);
  assert.equal(requests[0].data.requestId,requests[1].data.requestId);
  context.r.value='50';await run();
  assert.notEqual(requests[2].data.requestId,requests[0].data.requestId);
});
test('AC10: bets UI does not display unknown winnings as a loss',()=>{
  const source=fs.readFileSync(require.resolve('../admin.titanrust.ru/public/assets/UserDetailPage-B3f66ZEa.js'),'utf8');
  const start=source.indexOf('function J(P){',source.indexOf('__name:"UserBetsTab"'));
  const end=source.indexOf('return(P,k)=>',start);
  const result=vm.runInNewContext(source.slice(start,end)+';z({winAmount:null,betAmount:"100"})',{ae:x=>String(x)});
  assert.equal(result,'—');
});
