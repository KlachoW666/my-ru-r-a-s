'use strict';

/**
 * Достижения: считаются из уже имеющихся данных, выдают мини-бонус и
 * показываются игроку уведомлением.
 *
 * ПОЧЕМУ ПРОГРЕСС НЕ ХРАНИТСЯ, А СЧИТАЕТСЯ
 *
 * Всё, на чём держатся достижения, уже лежит в transactions и inventory:
 * открытия, оборот, победы, депозиты, лучший дроп. Отдельный счётчик пришлось
 * бы обновлять на каждом действии — а любая пропущенная запись навсегда съела
 * бы прогресс игрока, и починить это было бы нечем.
 *
 * Здесь прогресс выводится из источника: несколько агрегирующих запросов на
 * весь список. Значит его нельзя потерять и можно пересчитать в любой момент.
 * Хранится только ФАКТ открытия и получения (user_achievements) — потому что
 * бонус выдаётся один раз, и вот это забывать нельзя.
 *
 * НАГРАДУ ЗАБИРАЕТ ИГРОК, А НЕ СИСТЕМА
 *
 * evaluate() только открывает достижение. Бонус начисляет claim() по нажатию
 * «Получить» — в уведомлении или позже в профиле. Так награда не пропадёт
 * незамеченной: закрыл уведомление — она осталась ждать в профиле.
 *
 * ИДЕМПОТЕНТНОСТЬ
 *
 * Ключ (user_id, code) уникален, поэтому достижение открывается один раз.
 * Награда начисляется под условием claimed_at IS NULL с проверкой changes:
 * два параллельных нажатия «Получить» дадут один бонус, а не два.
 */

const { transaction } = require('./sqliteTransaction');

/**
 * Метрики. Каждая — одно число по игроку, посчитанное из источника.
 *
 * Ключ метрики → SQL, возвращающий столбец v.
 */
const METRICS = {
  // xN в комментарии: одно открытие пятёркой считается за пять.
  casesOpened: {
    sql: `SELECT COALESCE(SUM(CASE WHEN comment LIKE '%x%'
            THEN CAST(REPLACE(SUBSTR(comment, INSTR(comment,' x')+2), ' ', '') AS INTEGER) ELSE 1 END), 0) AS v
          FROM transactions WHERE user_id = ? AND type = 'case_open'`
  },
  wagered: {
    sql: `SELECT COALESCE(SUM(ABS(amount)), 0) AS v FROM transactions
          WHERE user_id = ? AND type IN ('case_open','upgrade','battle_entry')`
  },
  upgradesPlayed: { sql: `SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'upgrade'` },
  upgradesWon:    { sql: `SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'upgrade_win'` },
  battlesPlayed:  { sql: `SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'battle_entry'` },
  battlesWon:     { sql: `SELECT COUNT(*) AS v FROM transactions WHERE user_id = ? AND type = 'battle_win'` },
  deposited:      { sql: `SELECT COALESCE(SUM(amount), 0) AS v FROM transactions WHERE user_id = ? AND type = 'deposit'` },
  wheelSpins:     { sql: `SELECT COUNT(*) AS v FROM wheel_rounds WHERE user_id = ?`, optional: 'wheel_rounds' },
  bestDrop:       { sql: `SELECT COALESCE(MAX(price), 0) AS v FROM inventory WHERE user_id = ?`, optional: 'inventory' },
  itemsWon:       { sql: `SELECT COUNT(*) AS v FROM inventory WHERE user_id = ?`, optional: 'inventory' },
  raritiesOwned:  { sql: `SELECT COUNT(DISTINCT rarity) AS v FROM inventory WHERE user_id = ?`, optional: 'inventory' }
};

/**
 * Список достижений.
 *
 * reward — мини-бонус за получение:
 *   balance   рубли на счёт
 *   spin      попытка колеса
 *   discount  скидка на кейс
 *
 * Размер бонуса намеренно небольшой и растёт со сложностью: смысл в поводе
 * вернуться, а не в заработке на достижениях.
 */
const CATALOG = [
  // --- Кейсы ---------------------------------------------------------------
  { code: 'case_1',    group: 'Кейсы', title: 'Первый кейс',      metric: 'casesOpened', threshold: 1,     reward: { kind: 'balance', value: 10 } },
  { code: 'case_10',   group: 'Кейсы', title: 'Разогрев',          metric: 'casesOpened', threshold: 10,    reward: { kind: 'balance', value: 25 } },
  { code: 'case_100',  group: 'Кейсы', title: 'Сотня за плечами',  metric: 'casesOpened', threshold: 100,   reward: { kind: 'spin',    value: 1 } },
  { code: 'case_500',  group: 'Кейсы', title: 'Завсегдатай',       metric: 'casesOpened', threshold: 500,   reward: { kind: 'discount', value: 25, maxCasePrice: 599 } },
  { code: 'case_1000', group: 'Кейсы', title: 'Тысячник',          metric: 'casesOpened', threshold: 1000,  reward: { kind: 'balance', value: 500 } },

  // --- Оборот --------------------------------------------------------------
  { code: 'wager_1k',   group: 'Оборот', title: 'Первая тысяча',   metric: 'wagered', threshold: 1000,    reward: { kind: 'balance', value: 15 } },
  { code: 'wager_10k',  group: 'Оборот', title: 'Десять тысяч',    metric: 'wagered', threshold: 10000,   reward: { kind: 'spin',    value: 1 } },
  { code: 'wager_100k', group: 'Оборот', title: 'Сто тысяч',       metric: 'wagered', threshold: 100000,  reward: { kind: 'discount', value: 35, maxCasePrice: 599 } },
  { code: 'wager_1m',   group: 'Оборот', title: 'Миллион',         metric: 'wagered', threshold: 1000000, reward: { kind: 'balance', value: 1000 } },

  // --- Апгрейдер -----------------------------------------------------------
  { code: 'up_first',  group: 'Апгрейдер', title: 'Первый апгрейд', metric: 'upgradesPlayed', threshold: 1,  reward: { kind: 'balance', value: 10 } },
  { code: 'up_win1',   group: 'Апгрейдер', title: 'Повезло',        metric: 'upgradesWon',    threshold: 1,  reward: { kind: 'balance', value: 20 } },
  { code: 'up_win10',  group: 'Апгрейдер', title: 'Рука набита',    metric: 'upgradesWon',    threshold: 10, reward: { kind: 'spin',    value: 1 } },
  { code: 'up_win50',  group: 'Апгрейдер', title: 'Мастер риска',   metric: 'upgradesWon',    threshold: 50, reward: { kind: 'balance', value: 300 } },

  // --- Замесы --------------------------------------------------------------
  { code: 'bt_first',  group: 'Замесы', title: 'Первый замес',   metric: 'battlesPlayed', threshold: 1,  reward: { kind: 'balance', value: 10 } },
  { code: 'bt_win1',   group: 'Замесы', title: 'Первая победа',  metric: 'battlesWon',    threshold: 1,  reward: { kind: 'balance', value: 25 } },
  { code: 'bt_win10',  group: 'Замесы', title: 'Боец',           metric: 'battlesWon',    threshold: 10, reward: { kind: 'spin',    value: 1 } },
  { code: 'bt_win50',  group: 'Замесы', title: 'Ветеран арены',  metric: 'battlesWon',    threshold: 50, reward: { kind: 'balance', value: 400 } },

  // --- Дропы ---------------------------------------------------------------
  { code: 'drop_1k',   group: 'Дропы', title: 'Хороший лут',     metric: 'bestDrop', threshold: 1000,  reward: { kind: 'balance', value: 20 } },
  { code: 'drop_10k',  group: 'Дропы', title: 'Крупная рыба',    metric: 'bestDrop', threshold: 10000, reward: { kind: 'spin',    value: 1 } },
  { code: 'drop_50k',  group: 'Дропы', title: 'Джекпот',         metric: 'bestDrop', threshold: 50000, reward: { kind: 'balance', value: 750 } },
  { code: 'items_50',  group: 'Дропы', title: 'Коллекционер',    metric: 'itemsWon', threshold: 50,    reward: { kind: 'balance', value: 50 } },
  { code: 'rarity_5',  group: 'Дропы', title: 'Полный набор',    metric: 'raritiesOwned', threshold: 5, reward: { kind: 'discount', value: 25, maxCasePrice: 599 } },

  // --- Пополнения ----------------------------------------------------------
  { code: 'dep_first', group: 'Пополнения', title: 'Первый депозит', metric: 'deposited', threshold: 1,      reward: { kind: 'spin',    value: 1 } },
  { code: 'dep_1k',    group: 'Пополнения', title: 'Тысяча',         metric: 'deposited', threshold: 1000,   reward: { kind: 'balance', value: 30 } },
  { code: 'dep_10k',   group: 'Пополнения', title: 'Десятка',        metric: 'deposited', threshold: 10000,  reward: { kind: 'discount', value: 35, maxCasePrice: 599 } },
  { code: 'dep_100k',  group: 'Пополнения', title: 'Сотня',          metric: 'deposited', threshold: 100000, reward: { kind: 'balance', value: 2000 } },

  // --- Колесо --------------------------------------------------------------
  { code: 'wheel_1',   group: 'Колесо', title: 'Первый прокрут', metric: 'wheelSpins', threshold: 1,  reward: { kind: 'balance', value: 10 } },
  { code: 'wheel_10',  group: 'Колесо', title: 'Испытатель',     metric: 'wheelSpins', threshold: 10, reward: { kind: 'balance', value: 50 } },
  { code: 'wheel_50',  group: 'Колесо', title: 'Крутильщик',     metric: 'wheelSpins', threshold: 50, reward: { kind: 'spin',    value: 1 } }
];

const rewardText = r => r.kind === 'balance' ? `${r.value} ₽`
  : r.kind === 'spin' ? `${r.value} прокрут колеса`
  : `скидка ${r.value}% на кейс до ${r.maxCasePrice} ₽`;

function makeAchievementsService({ getAdminDb, queryAdminDb }) {
  let ready;
  function ensureSchema() {
    if (!ready) ready = transaction(getAdminDb, async ({ run }) => {
      await run(`CREATE TABLE IF NOT EXISTS user_achievements (
        user_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        unlocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
        reward_kind TEXT,
        reward_value REAL,
        notified_at TEXT,
        claimed_at TEXT,
        PRIMARY KEY (user_id, code))`);
      // База могла быть создана до появления кнопки «Получить».
      await run('ALTER TABLE user_achievements ADD COLUMN claimed_at TEXT').catch(() => {});
      await run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT,
        amount REAL, comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    }).catch(e => { ready = undefined; throw e; });
    return ready;
  }

  async function tableExists(name) {
    const rows = await queryAdminDb(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
    return !rows.failed && rows.length > 0;
  }

  /** Все метрики игрока одним проходом. Недостающие таблицы дают 0, а не падение. */
  async function metrics(userId) {
    const out = {};
    for (const [key, def] of Object.entries(METRICS)) {
      if (def.optional && !(await tableExists(def.optional))) { out[key] = 0; continue; }
      const rows = await queryAdminDb(def.sql, [userId]);
      out[key] = rows.failed || !rows.length ? 0 : Number(rows[0].v) || 0;
    }
    return out;
  }

  /** Начисление мини-бонуса внутри транзакции выдачи. */
  async function grant(tx, userId, reward) {
    if (reward.kind === 'balance') {
      const upd = await tx.run('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?',
        [Number(reward.value), userId]);
      if (upd.changes !== 1) throw Object.assign(new Error('Не удалось начислить бонус'), { status: 503 });
      await tx.run(`INSERT INTO transactions (user_id, type, amount, comment)
        VALUES (?, 'achievement', ?, ?)`, [userId, Number(reward.value), 'Награда за достижение']);
      return;
    }
    if (reward.kind === 'spin') {
      await tx.run(`CREATE TABLE IF NOT EXISTS wheel_spins (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
        granted_key TEXT NOT NULL, granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        consumed_at TEXT, round_id INTEGER)`);
      await tx.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wheel_spin_key ON wheel_spins(user_id, granted_key)`);
      for (let i = 0; i < Number(reward.value); i++) {
        await tx.run(`INSERT OR IGNORE INTO wheel_spins (user_id, kind, granted_key) VALUES (?, 'achievement', ?)`,
          [userId, `achievement:${reward.code}:${i}`]);
      }
      return;
    }
    if (reward.kind === 'discount') {
      await tx.run(`CREATE TABLE IF NOT EXISTS case_discounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, percent INTEGER NOT NULL,
        max_case_price REAL NOT NULL, source TEXT NOT NULL, granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT, used_at TEXT, used_case_slug TEXT)`);
      await tx.run(`INSERT INTO case_discounts (user_id, percent, max_case_price, source, expires_at)
        VALUES (?, ?, ?, 'achievement', ?)`,
        [userId, Number(reward.value), Number(reward.maxCasePrice),
         new Date(Date.now() + 14 * 86400000).toISOString()]);
    }
  }

  /**
   * Пересчитать прогресс и отметить всё, что заслужено.
   *
   * Награда здесь НЕ начисляется — только открывается достижение. Забирает её
   * игрок кнопкой «Получить», в уведомлении или позже в профиле. Так награда
   * не пропадёт незамеченной: закрыл уведомление — она осталась ждать.
   */
  async function evaluate(userId) {
    if (!userId) return { unlocked: [], metrics: {} };
    await ensureSchema();
    const m = await metrics(userId);
    const have = new Set((await queryAdminDb(
      'SELECT code FROM user_achievements WHERE user_id = ?', [userId])).map(r => r.code));
    const due = CATALOG.filter(a => !have.has(a.code) && (m[a.metric] || 0) >= a.threshold);
    if (!due.length) return { unlocked: [], metrics: m };

    const unlocked = [];
    for (const a of due) {
      try {
        await transaction(getAdminDb, async tx => {
          const ins = await tx.run(
            `INSERT OR IGNORE INTO user_achievements (user_id, code, reward_kind, reward_value)
             VALUES (?, ?, ?, ?)`, [userId, a.code, a.reward.kind, a.reward.value]);
          if (ins.changes !== 1) return;
          unlocked.push({ code: a.code, title: a.title, group: a.group,
            reward: a.reward, rewardText: rewardText(a.reward) });
        });
      } catch (error) {
        console.error(`[Achievements] ${a.code}:`, error.message);
      }
    }
    return { unlocked, metrics: m };
  }

  /**
   * Забрать награду за открытое достижение.
   *
   * Начисление и отметка «получено» — одна транзакция с условием
   * claimed_at IS NULL. Два параллельных нажатия дадут один бонус: второе
   * увидит changes = 0 и ничего не начислит.
   */
  async function claim(userId, code) {
    if (!userId) throw Object.assign(new Error('Нужно войти в аккаунт'), { status: 401 });
    const a = CATALOG.find(x => x.code === code);
    if (!a) throw Object.assign(new Error('Достижение не найдено'), { status: 404 });
    await ensureSchema();

    return transaction(getAdminDb, async tx => {
      const row = await tx.get(
        'SELECT claimed_at FROM user_achievements WHERE user_id = ? AND code = ?', [userId, code]);
      if (!row) throw Object.assign(new Error('Достижение ещё не открыто'), { status: 409, code: 'NOT_UNLOCKED' });
      if (row.claimed_at) throw Object.assign(new Error('Награда уже получена'), { status: 409, code: 'ALREADY_CLAIMED' });

      const taken = await tx.run(
        `UPDATE user_achievements SET claimed_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND code = ? AND claimed_at IS NULL`, [userId, code]);
      if (taken.changes !== 1) {
        throw Object.assign(new Error('Награда уже получена'), { status: 409, code: 'ALREADY_CLAIMED' });
      }
      await grant(tx, userId, { ...a.reward, code: a.code });
      const balance = await tx.get('SELECT balance FROM users WHERE id = ?', [userId]);
      return { code: a.code, title: a.title, reward: a.reward, rewardText: rewardText(a.reward),
        balance: Number(balance?.balance) || 0 };
    });
  }

  /** Список для профиля: что получено, что в процессе. */
  async function list(userId) {
    await ensureSchema();
    const m = userId ? await metrics(userId) : {};
    const rows = userId
      ? await queryAdminDb('SELECT code, unlocked_at, claimed_at FROM user_achievements WHERE user_id = ?', [userId])
      : [];
    const done = new Map((rows.failed ? [] : rows).map(r => [r.code, r]));
    const items = CATALOG.map(a => {
      const value = Number(m[a.metric]) || 0;
      const row = done.get(a.code);
      return {
        code: a.code, title: a.title, group: a.group, metric: a.metric,
        threshold: a.threshold, progress: Math.min(value, a.threshold),
        percent: Math.min(100, Math.round(value / a.threshold * 100)),
        unlocked: Boolean(row), unlockedAt: row?.unlocked_at || null,
        claimed: Boolean(row?.claimed_at),
        claimable: Boolean(row) && !row.claimed_at,
        rewardText: rewardText(a.reward)
      };
    });
    return { items, total: items.length,
      unlocked: items.filter(i => i.unlocked).length,
      claimable: items.filter(i => i.claimable).length };
  }

  /** Уведомления, которые игрок ещё не видел. Помечаются показанными. */
  async function pending(userId) {
    if (!userId) return [];
    await ensureSchema();
    const rows = await queryAdminDb(
      `SELECT code, reward_kind, reward_value FROM user_achievements
       WHERE user_id = ? AND notified_at IS NULL ORDER BY unlocked_at`, [userId]);
    if (rows.failed || !rows.length) return [];
    const byCode = new Map(CATALOG.map(a => [a.code, a]));
    const out = rows.filter(r => byCode.has(r.code)).map(r => {
      const a = byCode.get(r.code);
      return { code: a.code, title: a.title, group: a.group, rewardText: rewardText(a.reward) };
    });
    await transaction(getAdminDb, async tx => {
      for (const r of rows) {
        await tx.run('UPDATE user_achievements SET notified_at = CURRENT_TIMESTAMP WHERE user_id = ? AND code = ?',
          [userId, r.code]);
      }
    }).catch(e => console.error('[Achievements notify]', e.message));
    return out;
  }

  return { ensureSchema, evaluate, claim, list, pending, metrics, CATALOG, METRICS, rewardText };
}

module.exports = { makeAchievementsService, CATALOG, METRICS, rewardText };
