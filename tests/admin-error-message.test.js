'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/*
test_strategy:
  artifact: compiled admin API error formatter
  rationale: The case form currently replaces actionable API messages with a generic server error.
  criticality: MEDIUM
  selected_types:
    - rationale: Error-envelope parsing is deterministic branching logic and can be evaluated directly from the shipped bundle.
      type: unit
      size: small
      framework: node:test
      dependencies: [node:vm, shipped admin bundle]
      gate: Gate 1
  rejected_types:
    - reason: HTTP and SQLite case mutations are already covered by content-contract.test.js; duplicating that boundary does not test this formatter.
      type: integration
    - reason: This is an internal admin screen, so Gate 3 is OFF and the repository has no Vue sources for a component test.
      type: component
    - reason: The consumer and provider ship together, so Gate 4 is OFF.
      type: contract
    - reason: Two finite response-envelope variants do not justify property-based testing.
      type: property-based
  deliberately_skipped:
    - why: Production passkey access is unavailable to automated tests.
      what: Authenticated post-deploy browser smoke
Test Cases to Cover:
- [unit] AC1 a flat `{message}` returned by the server is shown verbatim.
- [unit] AC2 the existing nested `{error:{message}}` envelope remains supported.
*/

function formatter() {
  const filename=path.resolve(__dirname,'../admin.titanrust.ru/public/assets/index-D4siiPNB.js');
  const source=fs.readFileSync(filename,'utf8');
  const start=source.indexOf('function fE('),end=source.indexOf('function Nd()',start);
  assert.ok(start>=0&&end>start,'error formatter must be present in the compiled bundle');
  const context={};
  vm.runInNewContext(source.slice(start,end)+'\nthis.formatAdminError=dE;',context);
  return context.formatAdminError;
}

test('AC1 flat API error message remains visible',()=>{
  assert.equal(formatter()({response:{status:500,data:{message:'SQLITE_BUSY: database is locked'}}}),
    'SQLITE_BUSY: database is locked');
});

test('AC2 nested API error message remains visible',()=>{
  assert.equal(formatter()({response:{status:400,data:{error:{message:'Некорректный состав кейса'}}}}),
    'Некорректный состав кейса');
});
