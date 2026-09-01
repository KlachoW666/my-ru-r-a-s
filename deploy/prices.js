#!/usr/bin/env node
'use strict';

/**
 * Обновление цен каталога из steamdataapi.com.
 *
 * Смена источника цен меняет экономику: от цены предмета зависят выплаты,
 * RTP кейсов и стоимость входа в баттлы. Поэтому по умолчанию скрипт ничего
 * не пишет — только показывает, что изменится.
 *
 *   node deploy/prices.js                 сравнить, ничего не менять
 *   node deploy/prices.js --apply         записать новые цены
 *   node deploy/prices.js --field best    посмотреть другое поле цены
 *
 * Редкость и цвет не трогаются никогда: их источник — обход Steam Market,
 * а в этом API редкости нет вовсе.
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fieldIdx = args.indexOf('--field');
if (fieldIdx !== -1 && args[fieldIdx + 1]) process.env.STEAMDATA_PRICE_FIELD = args[fieldIdx + 1];

const catalog = require(path.join(ROOT, 'services', 'steamCatalog'));
const api = require(path.join(ROOT, 'services', 'steamDataApi'));

const run = (db, sql, p = []) => new Promise((res) => db.run(sql, p, function (e) { res(e ? null : this); }));
const all = (db, sql, p = []) => new Promise((res) => db.all(sql, p, (e, r) => res(e ? [] : r || [])));

const money = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

(async () => {
  if (!api.isConfigured()) {
    console.error('');
    console.error('  STEAMDATA_API_KEY не задан.');
    console.error('  Ключ бесплатный: https://steamdataapi.com/app');
    console.error('  Дальше прописать его в .env и запустить снова.');
    console.error('');
    process.exit(1);
  }

  const db = catalog.openDb();
  if (!db) { console.error('Не открылась база'); process.exit(1); }

  await catalog.ensureCatalogSchema(db);
  // Курс нужен до пересчёта: цены приходят в центах USD.
  await catalog.refreshFxRate();

  console.log('');
  console.log(`  Поле цены:  ${api.PRICE_FIELD}`);
  console.log(`  Режим:      ${APPLY ? 'ЗАПИСЬ' : 'только сравнение'}`);
  console.log('  Загружаю каталог одним запросом…');

  const r = await api.refreshPrices({
    db, run, all,
    usdCentsToRub: catalog.usdCentsToRub,
    dryRun: !APPLY
  });

  if (!r.ok) {
    console.error(`\n  Не получилось: ${r.message}\n`);
    db.close();
    process.exit(1);
  }

  console.log('');
  console.log(`  Пришло из API:      ${r.fromApi}`);
  console.log(`  Есть в каталоге:    ${r.inCatalog}`);
  console.log(`  Совпало и обновится: ${r.updated}`);
  console.log(`  Нет у нас:          ${r.unknown}  (заводит их обход Steam, здесь нет редкости)`);
  console.log(`  Без цены:           ${r.skipped}`);
  console.log(`  Картинок починится: ${r.imagesFixed}`);
  console.log('');
  console.log(`  Сумма каталога было:  ${money(r.sumOld)}`);
  console.log(`  Станет:               ${money(r.sumNew)}`);
  console.log(`  Сдвиг:                ${r.shiftPercent > 0 ? '+' : ''}${r.shiftPercent}%   (дороже ${r.grew}, дешевле ${r.fell})`);
  if (r.cachedAt) console.log(`  Данные на:            ${r.cachedAt}`);

  if (r.biggest.length) {
    console.log('');
    console.log('  Сильнее всего разойдутся:');
    for (const b of r.biggest) {
      console.log(`    ${String(b.diff + '%').padStart(5)}  ${money(b.oldRub).padStart(12)} -> ${money(b.rub).padStart(12)}  ${b.name}`);
    }
  }

  console.log('');
  if (!APPLY) {
    console.log('  Ничего не записано. Устраивает — повторите с --apply');
    if (Math.abs(r.shiftPercent) > 15) {
      console.log('');
      console.log(`  ! Сдвиг ${r.shiftPercent}% заметный. Он сдвинет и RTP кейсов:`);
      console.log('    после записи проверьте curl -s http://127.0.0.1:3101/api/v1/cases/health');
    }
  } else {
    console.log('  Цены записаны. Редкость и цвет не тронуты.');
  }
  console.log('');
  db.close();
})().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
