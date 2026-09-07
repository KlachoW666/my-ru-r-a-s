'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Unit regression: the legacy API may return limited:true, not a supply snapshot.
// No money operations; test the actual store factory with a ref/container adapter.
function store() {
  const source = fs.readFileSync(path.join(__dirname, '../public/assets/js/useLimitedRemaining-DdqYRIiF.js'), 'utf8')
    .replace(/import\{[^}]+\}from"[^"]+";/g, '').replace(/export\{[^}]+\};/, '');
  const ctx = {t: (_, setup) => setup, s: value => ({value}), a: fn => ({get value(){return fn();}})};
  vm.runInNewContext(source + ';this.makeStore=l;', ctx);
  return ctx.makeStore();
}
for (const [label, snapshot] of [['boolean',true],['null',null],['missing counts',{}],['NaN',{remaining:NaN,supplyTotal:10}],['negative',{remaining:-1,supplyTotal:10}]]) {
  test('ignores invalid limited snapshot: '+label, () => {
    const state=store();state.applyRemaining('case',snapshot,'poll');
    assert.equal(state.state.value.case,undefined);
  });
}
test('valid sold-out snapshot is not discarded', () => {
  const state=store();state.applyRemaining('case',{remaining:0,supplyTotal:10,status:'sold_out'},'poll');
  assert.equal(state.state.value.case.remaining,0);
});
test('polling cannot increase remaining without a supply change', () => {
  const state=store();state.applyRemaining('case',{remaining:4,supplyTotal:10,status:'active'},'poll');
  state.applyRemaining('case',{remaining:8,supplyTotal:10,status:'active'},'poll');
  assert.equal(state.state.value.case.remaining,4);
});
