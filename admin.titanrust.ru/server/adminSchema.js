'use strict';

/**
 * Схема для разделов админки, у которых её не было.
 *
 * Аудит показал: из 59 эндпоинтов, которые дёргает фронт админки, 8 работали,
 * 8 отдавали объект-заглушку, 14 — пустой массив, а 29 вообще не имели роутов
 * и проваливались в catch-all `app.all('/api/v1/admin/*')`, который отвечает
 * `{success:true, data:[]}`. Из-за этого разделы открывались, но были пустыми
 * и ничего не сохраняли.
 *
 * Здесь создаются недостающие таблицы и складываются разумные значения по
 * умолчанию. Всё идемпотентно: CREATE TABLE IF NOT EXISTS и вставка только
 * когда таблица пуста.
 */

const DDL = [
  // --- Боты -----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, avatar TEXT, balance REAL DEFAULT 0,
    strategy TEXT DEFAULT 'random', min_bet REAL DEFAULT 50, max_bet REAL DEFAULT 5000,
    active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS bot_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, avatar TEXT, behavior TEXT DEFAULT 'balanced',
    min_bet REAL DEFAULT 50, max_bet REAL DEFAULT 5000,
    join_delay_sec INTEGER DEFAULT 5, active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  // --- Финансы --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS commission_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, kind TEXT DEFAULT 'withdraw', percent REAL DEFAULT 0,
    min_amount REAL DEFAULT 0, max_amount REAL DEFAULT 0,
    active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS wallet_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE, name TEXT, kind TEXT DEFAULT 'deposit',
    icon TEXT, enabled INTEGER DEFAULT 1,
    min_amount REAL DEFAULT 100, max_amount REAL DEFAULT 500000,
    fee_percent REAL DEFAULT 0, position INTEGER DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS wallet_countries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE, name TEXT, currency TEXT DEFAULT 'RUB', enabled INTEGER DEFAULT 1)`,

  `CREATE TABLE IF NOT EXISTS wallet_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT UNIQUE, rate REAL DEFAULT 1, source TEXT DEFAULT 'manual',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS deposit_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL, bonus_percent REAL DEFAULT 0, position INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1)`,

  `CREATE TABLE IF NOT EXISTS skin_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, username TEXT, item_name TEXT, item_image TEXT,
    price REAL DEFAULT 0, status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reviewed_at TIMESTAMP)`,

  // --- Пользователи ---------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE, role TEXT DEFAULT 'admin', note TEXT,
    used_by TEXT, used_at TIMESTAMP, expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS kyc_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, username TEXT, level INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending', documents TEXT, comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reviewed_at TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS kyc_levels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level INTEGER UNIQUE, title TEXT, withdraw_limit REAL DEFAULT 0,
    requirements TEXT, enabled INTEGER DEFAULT 1)`,

  `CREATE TABLE IF NOT EXISTS guardian_ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT, reason TEXT, blocked_by TEXT,
    expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS guardian_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT DEFAULT 'ip', pattern TEXT, action TEXT DEFAULT 'block',
    note TEXT, active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS streamers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, nickname TEXT, platform TEXT DEFAULT 'twitch', url TEXT,
    promo_code TEXT, revenue_share REAL DEFAULT 5, active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  // --- Игры и RTP -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS rtp_tiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, rtp REAL DEFAULT 95, min_deposit REAL DEFAULT 0,
    max_deposit REAL DEFAULT 0, priority INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS rtp_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE, tier_id INTEGER, rtp_override REAL,
    assigned_by TEXT, assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  // --- Система --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS promo_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE, kind TEXT DEFAULT 'balance', value REAL DEFAULT 0,
    uses_limit INTEGER DEFAULT 0, uses_count INTEGER DEFAULT 0,
    min_deposit REAL DEFAULT 0, expires_at TIMESTAMP, active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, body TEXT, audience TEXT DEFAULT 'all',
    status TEXT DEFAULT 'draft', sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  /**
   * Настройки разделов, у которых нет своей таблицы: одна строка на ключ,
   * значение — JSON. Так секции вроде «Настройки игр» или «Топ дропов»
   * сохраняются без отдельной схемы под каждую.
   */
  // Игры и соцсети — списки со строчным редактированием (PUT /config/games/:id),
  // поэтому им нужны таблицы, а не одна запись в app_settings.
  `CREATE TABLE IF NOT EXISTS game_configs (
    id TEXT PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1,
    min_bet REAL DEFAULT 10, max_bet REAL DEFAULT 50000, house_edge REAL DEFAULT 5)`,

  `CREATE TABLE IF NOT EXISTS social_links (
    id TEXT PRIMARY KEY, name TEXT, url TEXT, enabled INTEGER DEFAULT 1, position INTEGER DEFAULT 0)`,

  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,

  `CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_requests(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_guardian_ip ON guardian_ips(ip)`,
  `CREATE INDEX IF NOT EXISTS idx_promo_code ON promo_codes(code)`
];

/** Значения по умолчанию: раздел не должен открываться пустым. */
const SEEDS = [
  ['wallet_methods', `INSERT INTO wallet_methods (code, name, kind, icon, enabled, min_amount, max_amount, fee_percent, position) VALUES
     ('card','Банковская карта','deposit','/assets/wallet/pm-cards.svg',1,100,150000,0,0),
     ('sbp','СБП','deposit','/assets/wallet/sbp.svg',1,100,150000,0,1),
     ('crypto','Криптовалюта','deposit','/assets/wallet/pm-crypto.svg',1,300,1000000,0,2),
     ('skins','Скины Steam','deposit','/assets/wallet/pm-skins.svg',1,50,500000,0,3),
     ('card_out','Вывод на карту','withdraw','/assets/wallet/pm-cards.svg',1,500,100000,5,0),
     ('crypto_out','Вывод в крипте','withdraw','/assets/wallet/pm-crypto.svg',1,1000,1000000,3,1)`],

  ['wallet_countries', `INSERT INTO wallet_countries (code, name, currency, enabled) VALUES
     ('RU','Россия','RUB',1),('KZ','Казахстан','KZT',1),('BY','Беларусь','BYN',1),('UA','Украина','UAH',0)`],

  ['wallet_rates', `INSERT INTO wallet_rates (currency, rate, source) VALUES
     ('RUB',1,'base'),('USD',83.24,'auto'),('EUR',90.1,'auto'),('KZT',0.17,'manual'),('BYN',25.4,'manual')`],

  ['deposit_presets', `INSERT INTO deposit_presets (amount, bonus_percent, position, enabled) VALUES
     (100,0,0,1),(500,5,1,1),(1000,10,2,1),(2500,12,3,1),(5000,15,4,1)`],

  ['commission_rates', `INSERT INTO commission_rates (name, kind, percent, min_amount, max_amount, active) VALUES
     ('Вывод на карту','withdraw',5,500,100000,1),
     ('Вывод в крипте','withdraw',3,1000,1000000,1),
     ('Пополнение картой','deposit',0,100,150000,1)`],

  ['kyc_levels', `INSERT INTO kyc_levels (level, title, withdraw_limit, requirements, enabled) VALUES
     (0,'Без верификации',5000,'Без документов',1),
     (1,'Базовый',50000,'Паспорт',1),
     (2,'Расширенный',500000,'Паспорт и подтверждение адреса',1),
     (3,'Полный',0,'Паспорт, адрес, источник средств',1)`],

  ['rtp_tiers', `INSERT INTO rtp_tiers (name, rtp, min_deposit, max_deposit, priority, active) VALUES
     ('Новичок',97,0,1000,0,1),
     ('Обычный',95,1000,10000,1,1),
     ('Активный',93,10000,100000,2,1),
     ('Кит',91,100000,0,3,1)`],

  ['bot_profiles', `INSERT INTO bot_profiles (name, avatar, behavior, min_bet, max_bet, join_delay_sec, active) VALUES
     ('Осторожный','/assets/battles/bot-badge.svg','careful',50,500,8,1),
     ('Сбалансированный','/assets/battles/bot-badge.svg','balanced',100,2000,5,1),
     ('Агрессивный','/assets/battles/bot-badge.svg','aggressive',500,10000,3,1)`],

  ['game_configs', `INSERT INTO game_configs (id, name, enabled, min_bet, max_bet, house_edge) VALUES
     ('cases','Открытие кейсов',1,10,50000,5),
     ('battles','Кейс-баттлы',1,50,100000,5),
     ('upgrader','Апгрейдер',1,10,50000,5),
     ('deposit_chain','Депозитная лестница',1,0,0,0)`],

  ['social_links', `INSERT INTO social_links (id, name, url, enabled, position) VALUES
     ('telegram','Telegram','https://t.me/kabangg',1,0),
     ('vk','VK','https://vk.com/kabangg',1,1),
     ('discord','Discord','',0,2)`],

  ['bots', `INSERT INTO bots (name, avatar, balance, strategy, min_bet, max_bet, active) VALUES
     ('Кабан-бот','/assets/battles/bot-badge.svg',100000,'balanced',100,2000,1),
     ('Рейдер','/assets/battles/bot-badge.svg',100000,'aggressive',500,10000,1),
     ('Барсук','/assets/battles/bot-badge.svg',100000,'careful',50,500,1)`]
];

/** Значения по умолчанию для key/value настроек. */
const SETTINGS = {
  games: {
    modes: [
      { name: 'case_opening', title: 'Открытие кейсов', enabled: true },
      { name: 'battle', title: 'Кейс-баттлы', enabled: true },
      { name: 'upgrade', title: 'Апгрейдер', enabled: true },
      { name: 'deposit_chain', title: 'Депозитная лестница', enabled: true },
      { name: 'online_badge', title: 'Счётчик онлайна', enabled: true }
    ],
    topDropsVisible: true,
    isMaintenance: false
  },
  topdrops: { enabled: true, visible: true, minPrice: 5000, limit: 20, period: 'day' },
  secret_cases: { enabled: true, slots: 24, revealIntervalHours: 24, autoAdvance: true },
  deposit_chain: {
    enabled: true, variant: 'A',
    tiers: [
      { name: 'Камень', threshold: 0 }, { name: 'Лук', threshold: 174 },
      { name: 'Двушка', threshold: 384 }, { name: 'Томпсон', threshold: 821 },
      { name: 'Калаш', threshold: 1166 }
    ]
  },
  wallet_config: { minDeposit: 100, maxDeposit: 150000, minWithdraw: 500, withdrawCooldownMin: 30, autoApproveUnder: 5000 },
  bots_config: { enabled: true, maxPerBattle: 3, joinDelaySec: 5, fillEmptySlotsAfterSec: 60 },
  streamer_configs: { enabled: true, defaultRevenueShare: 5, minPayout: 5000, showStatsPublicly: true },
  socials: {
    links: [
      { name: 'Telegram', url: 'https://t.me/kabangg', enabled: true },
      { name: 'VK', url: 'https://vk.com/kabangg', enabled: true },
      { name: 'Discord', url: '', enabled: false }
    ]
  }
};

async function ensureAdminSchema({ dbRun, dbGet }) {
  for (const sql of DDL) await dbRun(sql).catch(() => {});
  // Money-related schema must not silently fail and turn into a mock response.
  await require('../../services/upgradeBattles').ensureSchema(dbRun);

  let seeded = 0;
  for (const [table, insert] of SEEDS) {
    const row = await dbGet(`SELECT COUNT(*) AS c FROM ${table}`).catch(() => null);
    if (row && row.c === 0) { await dbRun(insert).catch(() => {}); seeded++; }
  }

  for (const [key, value] of Object.entries(SETTINGS)) {
    const row = await dbGet(`SELECT key FROM app_settings WHERE key = ?`, [key]).catch(() => null);
    if (!row) {
      await dbRun(`INSERT INTO app_settings (key, value) VALUES (?, ?)`, [key, JSON.stringify(value)]).catch(() => {});
      seeded++;
    }
  }

  if (seeded) console.log(`[Admin] Схема разделов готова, заполнено значений по умолчанию: ${seeded}`);
  return seeded;
}

module.exports = { ensureAdminSchema, SETTINGS };
