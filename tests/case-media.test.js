'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const formSource = read('admin.titanrust.ru/public/assets/CaseFormModal.vue_vue_type_script_setup_true_lang-84FjkQIS.js');
const ref = value => ({ value });
const computed = fn => ({ get value() { return fn(); } });

function uploader(post) {
  const errors = [], saved = ref('/uploads/cases/old.png');
  const scope = {
    f: ref, p: computed, A: saved, B: ref(false), _e: value => value,
    _: { error: e => errors.push(e), success() {} }, at: { post },
    URL: { createObjectURL: () => 'blob:case-preview', revokeObjectURL() {} },
    FormData: class { append() {} }, Error
  };
  const start = formSource.indexOf('const je=f(null)');
  const end = formSource.indexOf('const c=f([])', start);
  assert.ok(start > 0 && end > start);
  const u = vm.runInNewContext(formSource.slice(start, end) +
    ';({select:ht,upload:Ct,preview:re,file:M,clear:bt,optimize:kt})', scope);
  return { ...u, errors, saved };
}
const select = (u, size = 1024, name = 'cover.mp4', type = 'video/mp4') =>
  u.select({ target: { files: [{ size, name, type }], value: name } });

test('case picker accepts MP4 files', () => {
  const accept = formSource.match(/accept:"([^"]+)"/)[1].split(',');
  assert.ok(accept.includes('video/mp4'));
});

test('case preview has a video branch', () => {
  assert.match(formSource, /m\("video"/);
});

test('case upload keeps the saved URL after retrying a failed case save', async () => {
  let calls = 0;
  const u = uploader(async () => { calls++; return { data: { data: { path: '/uploads/cases/cover.mp4' } } }; });
  select(u);
  assert.equal(u.preview.value, 'blob:case-preview');
  assert.equal(await u.upload(), '/uploads/cases/cover.mp4');
  assert.equal(u.preview.value, '/uploads/cases/cover.mp4');
  assert.equal(await u.upload(), '/uploads/cases/cover.mp4');
  assert.equal(calls, 1);
});

test('empty upload response preserves the selected file for retry', async () => {
  const u = uploader(async () => ({ data: { data: {} } }));
  select(u);
  await assert.rejects(u.upload(), /адрес/);
  assert.equal(u.preview.value, 'blob:case-preview');
  assert.ok(u.file.value);
});

for (const size of [10 * 1024 * 1024 - 1, 10 * 1024 * 1024]) {
  test(`case media accepts ${size} bytes`, () => {
    const u = uploader();
    select(u, size);
    assert.ok(u.file.value);
    assert.equal(u.errors.length, 0);
  });
}

test('oversized selection preserves the previous cover', () => {
  const u = uploader();
  select(u, 10 * 1024 * 1024 + 1);
  assert.equal(u.file.value, null);
  assert.equal(u.preview.value, '/uploads/cases/old.png');
  assert.match(String(u.errors[0]), /10 МБ/);
});

test('unsupported media never replaces the existing cover', () => {
  const u = uploader();
  select(u, 1024, 'cover.html', 'text/html');
  assert.equal(u.file.value, null);
  assert.ok(u.errors.length);
});

test('video is never sent to the image optimizer', async () => {
  let calls = 0;
  const u = uploader(async () => { calls++; return { data: { data: {} } }; });
  u.saved.value = '/uploads/cases/cover.MP4?version=1';
  await u.optimize();
  assert.equal(calls, 0);
});

test('admin resolves uploaded media on its own origin', () => {
  const source = read('admin.titanrust.ru/public/assets/useImageUrl-B25ZvO8s.js');
  const resolve = vm.runInNewContext(source.replace(/export\{[^}]+\};?/, '') + ';e().imageUrl');
  assert.equal(resolve('/uploads/cases/cover.mp4'), '/uploads/cases/cover.mp4');
  assert.equal(resolve('https://example.com/cover.png'), 'https://example.com/cover.png');
});

function renderMedia(src, reduced = false) {
  const source = read('public/assets/js/index.vue_vue_type_script_setup_true_lang-BbzYopsK.js');
  const node = (tag, props, children) => ({ tag, props, children });
  const attrs = { alt: 'Animated case', class: 'cc-art', width: 167, onLoad() {} };
  const scope = {
    t: value => value, e: value => value, a: () => attrs, l: computed, s: ref,
    r() {}, i() {}, u: node, o: 'fragment', n: (xs, fn) => xs.map(fn),
    c: node, d: Object.assign, h: value => value, v: String,
    window: { matchMedia: () => ({ matches: reduced }) }
  };
  const component = vm.runInNewContext(source.slice(source.indexOf('const p=')).replace(/export\{[^}]+\};?/, '') + ';y', scope);
  const props = { src, set: [], title: 'Case', fallback: '', local: false, $attrs: attrs };
  return component.setup(props)(props, []);
}

for (const src of ['/uploads/cases/cover.mp4', 'https://example.com/cover.MP4?x=1#t=0.1']) {
  test(`public cover renders video: ${src}`, () => {
    const view = renderMedia(src);
    assert.equal(view.tag, 'video');
    assert.equal(view.props.src, src);
    assert.equal(view.props.muted, true);
    assert.equal(view.props.loop, true);
    assert.equal(view.props.playsinline, true);
    assert.equal(view.props.class, 'cc-art');
  });
}

test('reduced motion disables cover autoplay', () => {
  const view = renderMedia('/uploads/cases/cover.mp4', true);
  assert.equal(view.tag, 'video');
  assert.equal(view.props.autoplay, false);
});

test('PNG cover keeps the picture renderer', () => {
  const view = renderMedia('/uploads/cases/cover.png');
  assert.equal(view.tag, 'picture');
  assert.equal(view.children[1].tag, 'img');
  assert.equal(view.children[1].props.src, '/uploads/cases/cover.png');
});
