'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
test_strategy:
  artifact: admin static delivery
  rationale: Admin bundles are patched in place, so an offline precache can keep executing obsolete code after deployment.
  criticality: HIGH
  selected_types:
    - type: contract
      size: small
      framework: node:test
      gate: Gate 2
      rationale: The service-worker and Express cache contracts are fully observable in their shipped files.
  deliberately_skipped:
    - what: live browser cache replacement
      why: Requires an authenticated production browser after deployment.
Test Cases to Cover:
- [contract] AC1 service worker removes obsolete caches and does not precache mutable admin assets.
- [contract] AC2 Express serves mutable HTML/JS/service-worker files with no-store.
*/

const root = path.resolve(__dirname, '..');

test('AC1 admin service worker clears old precaches without caching mutable bundles', () => {
  const source = fs.readFileSync(path.join(root, 'admin.titanrust.ru/public/sw.js'), 'utf8');
  assert.match(source, /caches\.keys\(\)/);
  assert.match(source, /caches\.delete/);
  assert.doesNotMatch(source, /precacheAndRoute/);
  assert.doesNotMatch(source, /index-D4siiPNB\.js/);
});

test('AC2 admin mutable static files are explicitly no-store', () => {
  const source = fs.readFileSync(path.join(root, 'admin.titanrust.ru/server/server.js'), 'utf8');
  assert.match(source, /Cache-Control',\s*'no-store/);
  assert.match(source, /express\.static\(PUBLIC_DIR,\s*\{[\s\S]*setHeaders/);
});
