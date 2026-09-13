'use strict';
// HIGH risk: executable Bash guards + syntax; no live PM2 or database changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const source = fs.readFileSync('update.sh', 'utf8');
test('PM2 updater parses as Bash and has no destructive checkout or clean', () => {
  const result = spawnSync(bash, ['-n'], { input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(source, /git\s+(?:reset\s+--hard|clean\b|checkout\s+--)/);
  assert.match(source, /git merge --ff-only/);
});
test('runtime guard rejects incoming database, secrets and upload changes', () => {
  const start = source.indexOf('protected_path() {');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const checks = [
    'set -e', source.slice(start, end),
    'for file in .env .env.local admin.titanrust.ru/server/database.sqlite public/uploads/cases/a.png admin.titanrust.ru/public/uploads/a.png data/skins.json backups/db.sqlite ecosystem.install.config.cjs; do',
    '  protected_path "$file" || exit 41', 'done',
    'for file in server.js .env.example admin.titanrust.ru/server/adminPasswordAuth.js public/assets/a.js; do',
    '  if protected_path "$file"; then exit 42; fi', 'done'
  ].join('\n');
  const result = spawnSync(bash, ['--noprofile', '--norc'], { input: checks, encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
});
test('backup precedes downtime and code switch; boot precedes PM2 save', () => {
  assert.ok(source.indexOf('.backup') < source.indexOf('pm2 stop main-site'));
  assert.ok(source.indexOf('pm2 stop main-site') < source.indexOf('git merge --ff-only'));
  assert.ok(source.indexOf('wait_http "http://127.0.0.1:$SITE_PORT/') < source.indexOf('pm2 save'));
  assert.match(source, /auth\/invite\/validate/);
  assert.doesNotMatch(source, /auth\/passkeys/);
  assert.match(source, /cp -p -- "\$APP\/\.env"/);
});
