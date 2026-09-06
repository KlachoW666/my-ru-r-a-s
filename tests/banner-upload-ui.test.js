'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname,
  '../admin.titanrust.ru/public/assets/BannersListPage-CxiREAQ9.js'), 'utf8');
const ref = value => ({ value });
function uploader(post) {
  const start = source.indexOf('function Q(o,e,t="/media/upload")');
  const end = source.indexOf('const P=r(!1)', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(source.slice(start, end) + ';Q("banners",{value:null})', {
    r: ref, $: fn => ({ get value() { return fn(); } }), Z: x => x, Ne: { post },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} },
    FormData: class { append() {} }, Error
  });
}
const select = (u, size = 1024) => u.onChange({ target: { files: [{ size }], value: 'banner.png' } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('successful upload retains its URL for retrying the banner save', async () => {
  let calls = 0;
  const u = uploader(async () => { calls++; return { data: { data: { url: '/uploads/banners/new.png' } } }; });
  select(u);
  assert.equal(await u.upload(), '/uploads/banners/new.png');
  assert.equal(u.previewUrl.value, '/uploads/banners/new.png');
  assert.equal(await u.upload(), '/uploads/banners/new.png');
  assert.equal(calls, 1);
});

test('oversized image never reaches the network and failed uploads remain retryable', async () => {
  let calls = 0;
  const u = uploader(async () => { calls++; throw new Error('network'); });
  select(u, 10 * 1024 * 1024 + 1);
  await assert.rejects(u.upload(), /10 МБ/);
  assert.equal(calls, 0);
  select(u);
  await assert.rejects(u.upload(), /network/);
  await assert.rejects(u.upload(), /network/);
  assert.equal(calls, 2);
  assert.equal(u.uploading.value, false);
});

test('empty upload response preserves the pending image', async () => {
  let calls = 0;
  const u = uploader(async () => { calls++; return { data: {} }; });
  select(u);
  await assert.rejects(u.upload(), /адрес/);
  await assert.rejects(u.upload(), /адрес/);
  assert.equal(calls, 2);
});

test('save waits for every upload after a failure and ignores a simultaneous submit', async () => {
  const first = deferred(), second = deferred(), errors = [];
  let calls = 0, saves = 0;
  const state = ref(false);
  const scope = {
    S: state, Ce: ref(false), B: ref('Banner'), h: ref(''), V: ref(''), m: ref(''),
    u: { upload() { calls++; return first.promise; } },
    d: { upload() { calls++; return second.promise; } },
    v: { upload: async () => '' }, c: { upload: async () => '' },
    C: { error: e => errors.push(e), success() {} },
    Ae: { mutateAsync: async () => { saves++; } }
  };
  const start = source.indexOf('async function Be()');
  const end = source.indexOf('const R=r([])', start);
  assert.ok(start >= 0 && end > start);
  const submit = vm.runInNewContext(source.slice(start, end) + ';Be', scope);
  const pending = submit();
  first.reject(new Error('413'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.value, true, 'save stays locked while the other upload is pending');
  await submit();
  assert.equal(calls, 2, 'duplicate submit starts no more uploads');
  second.resolve('/uploaded.png');
  await pending;
  assert.equal(state.value, false);
  assert.equal(errors.length, 1);
  assert.equal(saves, 0);
});
