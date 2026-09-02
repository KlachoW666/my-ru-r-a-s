#!/usr/bin/env node
'use strict';

/**
 * Наполнение каталога предметов.
 *
 *   node deploy/seed-catalog.js                 посмотреть, что будет, не писать
 *   node deploy/seed-catalog.js --apply         записать
 *   node deploy/seed-catalog.js --limit 200     только первые 200 (проверка)
 *
 * Список берётся из полной выгрузки lis-skins, картинки и редкость — из Steam
 * GetAssetClassInfo по item_class_id, пачками по 100. Около 46 запросов и пары
 * минут на весь Rust вместо получаса постраничного обхода Market.
 *
 * Каталог меняет экономику: от цен зависят выплаты и RTP кейсов, поэтому по
 * умолчанию скрипт ничего не пишет.
 *
 * Требуется STEAM_API_KEY в .env — без него не будет ни картинок, ни редкости.
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const li = args.indexOf('--limit');
const LIMIT = li !== -1 && args[li + 1] ? Number(args[li + 1]) : 0;

if (args.includes('-h') || args.includes('--help')) {
  console.log(require('fs').readFileSync(__filename, 'utf8')
    .split('*/')[0].replace(/^#![^\n]*\n/, '').replace(/^'use strict';\n/m, '')
    .replace(/^\/\*\*?|^ \* ?/gm, '').trim());
  process.exit(0);
}

const catalog = require(path.join(ROOT, 'services', 'steamCatalog'));
const seeder = require(path.join(ROOT, 'services', 'catalogSeed'));

const num = (n) => Number(n || 0).toLocaleString('ru-RU');

(async () => {
  const db = catalog.openDb();
  if (!db) { console.error('Не открылась база'); process.exit(1); }
  // Обход Steam работает параллельно и держит базу — ждём, а не падаем.
  db.configure('busyTimeout', 15000);

  console.log('');
  console.log('  Список:     lis-skins, полная выгрузка');
  console.log('  Картинки и редкость: Steam GetAssetClassInfo');
  console.log(`  Режим:      ${APPLY ? 'ЗАПИСЬ' : 'только просмотр'}`);
  if (LIMIT) console.log(`  Ограничение: ${num(LIMIT)} предметов`);
  console.log('  Качаю выгрузку (16 МБ), это небыстро…');

  let lastPct = -1;
  const r = await seeder.seed({
    db,
    apiKey: process.env.STEAM_API_KEY,
    dryRun: !APPLY,
    limit: LIMIT,
    onProgress: ({ done, total, written }) => {
      const pct = Math.floor((done / total) * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      process.stdout.write(`\r  ${String(pct).padStart(3)}%  ${num(done)} / ${num(total)}   готово: ${num(written)}   `);
    }
  });

  process.stdout.write('\r' + ' '.repeat(70) + '\r');

  if (!r.ok) {
    console.error(`\n  Не получилось: ${r.message}\n`);
    db.close();
    process.exit(1);
  }

  console.log('');
  console.log(`  Лотов в выгрузке:    ${num(r.lots)}`);
  console.log(`  Уникальных вещей:    ${num(r.unique)}`);
  console.log(`  Обработано:          ${num(r.written)}   (новых ${num(r.created)}, обновлено ${num(r.updated)})`);
  if (r.noInfo)        console.log(`  Steam не опознал:    ${num(r.noInfo)}`);
  if (r.failedBatches) console.log(`  Неудачных пачек:     ${num(r.failedBatches)}  — повторите запуск, они дозаберутся`);
  console.log(`  Записей в каталоге:  ${num(r.countBefore)} -> ${num(r.countAfter)}`);
  if (r.updatedAt) console.log(`  Данные на:           ${r.updatedAt}`);

  console.log('');
  if (!APPLY) {
    console.log('  Ничего не записано. Устраивает — повторите с --apply');
  } else {
    console.log('  Каталог записан: имя, цена, редкость, картинка.');
    console.log('  Проверить:  curl -s http://127.0.0.1:3101/api/v1/cases/health');
  }
  console.log('');
  db.close();
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
