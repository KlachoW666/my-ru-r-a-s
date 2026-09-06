'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const source = fs.readFileSync(path.resolve(__dirname, '../deploy/update.sh'), 'utf8');
const begin = source.indexOf('  # Online backup');
const end = source.indexOf('  info "$BACKUP_FILE"', begin);
assert.ok(begin >= 0 && end > begin);
const backup = source.slice(begin, end);
const runStart = source.indexOf('run()  {');
const runEnd = source.indexOf('\n}', runStart) + 2;
const runFunction = source.slice(runStart, runEnd);

for (const scenario of ['retry', 'locked', 'invalid', 'dry']) {
  test(`backup deployment: ${scenario}`, { skip: !fs.existsSync(bash) }, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-backup-'));
    try {
      const script = `
set -Eeuo pipefail
DRY_RUN=0
[ "$SCENARIO" != dry ] || DRY_RUN=1
C_DIM='' C_OFF=''
BACKUP_FILE="$TASK_TEMP/final.sqlite"
DB_PATH="$TASK_TEMP/source.sqlite"
calls=0
info() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
sleep() { :; }
sqlite3() {
  if [ "$1" = -readonly ]; then
    if [ "$SCENARIO" = invalid ]; then printf 'corrupt\\n'; else printf 'ok\\n'; fi
    return 0
  fi
  [ "$1" = -cmd ] && [ "$2" = ".timeout 10000" ] || return 42
  calls=$((calls + 1))
  printf 'partial\\n' > "$BACKUP_TEMP"
  if [ "$SCENARIO" = locked ] || { [ "$SCENARIO" = retry ] && [ "$calls" -lt 3 ]; }; then
    printf 'locked\\n' >&2
    return 1
  fi
  printf 'complete\\n' > "$BACKUP_TEMP"
}
${runFunction}
${backup}
printf 'calls=%s\\n' "$calls"
`;
      const result = spawnSync(bash, ['--noprofile', '--norc'], {
        input: script, encoding: 'utf8',
        env: { ...process.env, SCENARIO: scenario, TASK_TEMP: temp.replaceAll('\\', '/') },
        timeout: 10000
      });
      if (result.error) throw result.error;
      const exists = fs.existsSync(path.join(temp, 'final.sqlite'));
      if (scenario === 'retry') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /calls=3/);
        assert.equal(fs.readFileSync(path.join(temp, 'final.sqlite'), 'utf8'), 'complete\n');
        assert.equal(fs.readdirSync(temp).length, 1, 'partial file is promoted only after validation');
      } else if (scenario === 'dry') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /calls=0/);
        assert.equal(fs.readdirSync(temp).length, 0);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(exists, false, 'failed backup must never be treated as complete');
        assert.match(result.stderr, scenario === 'locked' ? /SQLite остаётся занятой/ : /quick_check/);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
