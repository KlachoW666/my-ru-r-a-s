'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('../admin.titanrust.ru/server/node_modules/express');
const multer = require('../admin.titanrust.ru/server/node_modules/multer');

test('real upload accepts a 2 MiB image and rejects over 10 MiB without leaving a partial file', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-upload-test-'));
  const source = fs.readFileSync(path.resolve(__dirname, '../admin.titanrust.ru/server/server.js'), 'utf8');
  const start = source.indexOf('// Multer Storage Configuration');
  const end = source.indexOf('// Additional Feature Endpoints', start);
  assert.ok(start >= 0 && end > start);
  const app = express();
  vm.runInNewContext(source.slice(start, end), {
    app, express, multer, fs, path,
    __dirname: path.join(temp, 'admin', 'server'),
    requireAdminJWT: (req, res, next) => next(),
    console: { log() {}, error() {} }
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const upload = async size => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.alloc(size)], { type: 'image/png' }), 'banner.png');
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/media/upload?folder=banners`, {
        method: 'POST', body: form
      });
      return { status: response.status, body: await response.json() };
    };
    const accepted = await upload(2 * 1024 * 1024);
    assert.equal(accepted.status, 200);
    assert.match(accepted.body.data.url, /^\/uploads\/banners\/.+\.png$/);
    const folder = path.join(temp, 'public', 'uploads', 'banners');
    const originalFiles = fs.readdirSync(folder);
    assert.equal(originalFiles.length, 1);
    const rejected = await upload(10 * 1024 * 1024 + 1);
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.code, 'FILE_TOO_LARGE');
    assert.match(rejected.body.message, /10 МБ/);
    assert.deepEqual(fs.readdirSync(folder), originalFiles);

    // Real project MP4: ensure the upload is byte-preserving and seekable.
    const video = fs.readFileSync(path.join(__dirname, '../public/assets/raffle/mega-loop.mp4'));
    const videoForm = new FormData();
    videoForm.append('file', new Blob([video], { type: 'video/mp4' }), 'case.mp4');
    const videoResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/media/upload?folder=cases`, {
      method: 'POST', body: videoForm
    });
    assert.equal(videoResponse.status, 200);
    const media = (await videoResponse.json()).data;
    assert.match(media.path, /^\/uploads\/cases\/.+\.mp4$/);
    assert.deepEqual(fs.readFileSync(path.join(temp, 'public', media.path)), video);
    const range = await fetch(`http://127.0.0.1:${server.address().port}${media.path}`, {
      headers: { Range: 'bytes=0-31' }
    });
    assert.equal(range.status, 206);
    assert.match(range.headers.get('content-type'), /video\/mp4/);
    assert.equal(range.headers.get('content-range'), `bytes 0-31/${video.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), video.subarray(0, 32));
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
