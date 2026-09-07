'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
/* test_strategy:
 * artifact: BEARZ workshop bundle integration
 * rationale: Existing compiled entry must keep its shared Vue runtime and working routes.
 * criticality: MEDIUM-HIGH
 * selected_types:
 *   - rationale: Verify HTML, module and router integration without mutating game data.
 *     type: integration
 *     size: medium
 *     framework: node:test
 *     dependencies: [repository assets]
 *     gate: Gate 2
 *   - rationale: Layout and real links need an actual rendering engine.
 *     type: e2e
 *     size: large
 *     framework: browser-client manual smoke
 *     dependencies: [local site, in-app browser]
 *     gate: Gate 3
 * rejected_types:
 *   - reason: New modules only declare presentation; no calculation or state changes.
 *     type: unit
 *   - reason: No independently deployed API changed.
 *     type: contract
 *   - reason: No numeric input domain introduced.
 *     type: property-based
 * deliberately_skipped:
 *   - why: No production deployment or spending in a visual task.
 *     what: Gate 5 production/payment smoke
 */
test('public page titles use the new brand', () => {
  for (const file of ['public/index.html', 'public/manifest.webmanifest', 'public/assets/js/index-CyyoIbm1.js']) {
    assert.ok(read(file).includes('bearz.top'), file);
    assert.ok(!read(file).includes('bearup.top'), file);
  }
});
test('home preserves the live catalog and deposit gate', () => {
  const home = read('public/assets/js/index-DoTdMb5b.js');
  assert.ok(home.includes('m(l).isDepositChainEnabled'));
  assert.ok(home.includes('w(pl)'));
  assert.ok(home.includes('w(Nt)'));
  assert.ok(home.includes('w(WorkshopHero)'));
  assert.ok(home.includes('id:"bearz-catalog"'));
});
test('series titles use admin text instead of legacy graphic headings', () => {
  const home = read('public/assets/js/index-DoTdMb5b.js');
  assert.ok(home.includes('class:"bz-series-title"'));
  assert.ok(!home.includes('class:"cases-title",src:m(pe)(t.series.titleImage)'));
});
test('HTML keeps a single unversioned entry with workshop CSS', () => {
  const html = read('public/index.html');
  assert.equal((html.match(/src="\/assets\/js\/index-CyyoIbm1.js"/g)||[]).length, 1);
  assert.ok(!html.includes('index-CyyoIbm1.js?'));
  assert.ok(html.indexOf('bearz-workshop.css') > html.indexOf('satchel-theme.css'));
});
test('mode links target existing routes', () => {
  const source = read('public/assets/js/bearz-workshop.js');
  for (const route of ['/crate-pvp', '/crate-pvp?mode=upgrade', '/upgrader']) assert.ok(source.includes(`link('${route}'`));
  assert.ok(!/\bfetch\(|localStorage|setInterval|Math.random/.test(source));
});
test('workshop hero asset exists', () => {
  assert.ok(fs.statSync(path.join(__dirname, '../public/image/bear-gunsmith-banner-1470x630.png')).size > 0);
});

test('promo is grouped with the hero, not duplicated after the catalog', () => {
  const home = read('public/assets/js/index-DoTdMb5b.js');
  assert.ok(home.includes('class:"bz-welcome"'));
  assert.equal((home.match(/w\(Nt\)/g)||[]).length,1);
  assert.ok(home.indexOf('w(Nt)',home.indexOf('__name:"HomePage"')) < home.indexOf('id:"bearz-catalog"',home.indexOf('__name:"HomePage"')));
});
test('workshop ladder uses live deposit state instead of legacy dep2 markup', () => {
  assert.ok(read('public/assets/js/bearz-workshop.js').includes('useDepositChain()'));
  assert.ok(read('public/assets/js/index-DoTdMb5b.js').includes('g(WorkshopLadder'));
});

test('ladder renders live states, links, progress and collapse without spending', () => {
  const vm = require('node:vm');
  const state = {
    showLadder: {value:true}, completed:{value:false},
    activeTier:{value:{status:'ready'}}, activeCollected:{value:0},
    activeThreshold:{value:0}, activeProgress:{value:0},
    tierViews:{value:[{tierIndex:0,status:'ready',caseName:'Камень',caseSlug:'stone',thresholdNum:0}]},
    stateQuery:{refetch() {}}
  };
  const vnode = (tag,props,children) => ({tag,props:props||{},children});
  const source = read('public/assets/js/bearz-workshop.js').replace(/^import .*;$/gm,'').replace(/export const /g,'const ');
  const render = vm.runInNewContext(source+';WorkshopLadder.setup()', {
    element:vnode, component:vnode, RouterLink:'RouterLink',
    ref:value=>({value}), onMounted:fn=>fn(), useDepositChain:()=>state
  });
  let tree = render();
  const body = tree.children[1];
  assert.equal(body.children[0].children[0].children[0].props.to,'/cases/stone');
  assert.equal(body.children[1].children[1].children,'Можно забирать');
  assert.equal(body.children[1].children[2].props['aria-valuenow'],100);
  tree.children[0].children[1].props.onClick();
  assert.equal(render().children[1],null);
  tree.children[0].children[1].props.onClick();
  state.activeTier.value.status='locked';
  state.activeThreshold.value=200; state.activeCollected.value=50; state.activeProgress.value=.25;
  assert.equal(render().children[1].children[1].children[2].props['aria-valuenow'],25);
  state.completed.value=true;
  assert.equal(render().children[1].children[1].children[0].children,'Путь пройден');
  state.showLadder.value=false;
  assert.equal(render(),null);
});
