'use strict';

/**
 * Ролевая модель админки.
 *
 * Было: колонка `admin_users.role` существовала, но сервер её не читал —
 * `requireAdminJWT` пропускал любой действующий токен куда угодно. Любой
 * заведённый ключ получал права владельца: правку выплат, подтверждение
 * выводов, управление другими админами.
 *
 * Стало: каждый запрос к /api/v1/admin/* раскладывается на «раздел» (первый
 * сегмент пути) и «действие» (чтение или запись), раздел относится к домену,
 * а роль задаёт уровень доступа к домену. Проверка стоит внутри самого
 * `requireAdminJWT`, поэтому её нельзя обойти, забыв повесить middleware на
 * новый роут — включая catch-all.
 *
 * Уровни: none < read < write.
 *   read  — GET, HEAD, OPTIONS
 *   write — POST, PUT, PATCH, DELETE
 */

const LEVELS = { none: 0, read: 1, write: 2 };

/**
 * Раздел -> домен. Раздел — первый сегмент пути после /api/v1/admin.
 * Всё неперечисленное попадает в `system` — там же живёт catch-all.
 */
const DOMAIN_BY_SECTION = {
  // Контент и игровые сущности
  cases: 'content',
  upgrader: 'content',
  banners: 'content',
  pages: 'content',
  page: 'content',
  media: 'content',
  bots: 'content',
  streamers: 'content',
  giveaways: 'content',
  topdrops: 'content',
  'secret-cases': 'content',
  'deposit-chain': 'content',
  config: 'content',

  // Игроки и поддержка
  users: 'users',
  kyc: 'users',
  notifications: 'users',

  // Деньги
  wallet: 'finance',
  'wallet-config': 'finance',
  withdrawals: 'finance',
  deposits: 'finance',
  accounting: 'finance',
  transactions: 'finance',
  'commission-rates': 'finance',
  promo: 'finance',

  // Математика выплат — отдельно от денег: здесь задаётся отдача площадки
  rtp: 'economy',
  'upgrade-battles': 'economy',

  // Безопасность
  guardian: 'security',
  invites: 'security',

  // Сводки, которые видно всем
  stats: 'dashboard',

  // Управление самими администраторами
  admins: 'admins'
};

const DOMAINS = ['content', 'users', 'finance', 'economy', 'security', 'dashboard', 'system', 'admins'];

const DOMAIN_TITLES = {
  content: 'Контент и игры',
  users: 'Игроки и поддержка',
  finance: 'Финансы',
  economy: 'Выплаты и RTP',
  security: 'Безопасность',
  dashboard: 'Сводки',
  system: 'Настройки системы',
  admins: 'Администраторы'
};

/**
 * Роли. `all` — уровень по умолчанию для всех доменов, `domains` — исключения.
 * Порядок в объекте идёт от старшей роли к младшей и в таком же виде уходит
 * на экран управления администраторами.
 */
const ROLES = {
  SUPER_ADMIN: {
    title: 'Владелец',
    note: 'Полный доступ, включая заведение администраторов и смену ролей.',
    all: 'write'
  },
  ADMIN: {
    title: 'Администратор',
    note: 'Всё, кроме заведения администраторов и смены их ролей.',
    all: 'write',
    domains: { admins: 'read' }
  },
  FINANCE: {
    title: 'Финансист',
    note: 'Выводы, платежи, комиссии, промокоды и RTP. Остальное — чтение.',
    all: 'read',
    domains: { finance: 'write', economy: 'write', admins: 'none' }
  },
  MODERATOR: {
    title: 'Модератор',
    note: 'Игроки, KYC, блокировки и контент. Деньги — только чтение.',
    all: 'read',
    domains: { users: 'write', security: 'write', content: 'write', admins: 'none' }
  },
  VIEWER: {
    title: 'Наблюдатель',
    note: 'Только чтение.',
    all: 'read',
    domains: { admins: 'none' }
  }
};

const ROLE_NAMES = Object.keys(ROLES);
const DEFAULT_ROLE = 'VIEWER';

/** Раздел, доступный любому вошедшему: без него не выйдет даже войти. */
const ALWAYS_ALLOWED_SECTIONS = new Set(['auth']);

/**
 * Приводит роль к каноническому виду. Неизвестная роль трактуется как самая
 * слабая, а не самая сильная: мусор в базе не должен давать прав.
 */
function normalizeRole(role) {
  const r = String(role || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (ROLES[r]) return r;
  const aliases = {
    OWNER: 'SUPER_ADMIN', ROOT: 'SUPER_ADMIN', SUPERADMIN: 'SUPER_ADMIN',
    ADMINISTRATOR: 'ADMIN', MANAGER: 'ADMIN',
    FINANCIER: 'FINANCE', ACCOUNTANT: 'FINANCE',
    MOD: 'MODERATOR', SUPPORT: 'MODERATOR',
    READONLY: 'VIEWER', READ_ONLY: 'VIEWER', GUEST: 'VIEWER'
  };
  return aliases[r] || DEFAULT_ROLE;
}

/** Первый сегмент пути после /api/v1/admin. */
function sectionOf(pathname) {
  const p = String(pathname || '').split('?')[0];
  const m = p.match(/^\/api\/v1\/admin\/?(.*)$/);
  const rest = m ? m[1] : p.replace(/^\/+/, '');
  return (rest.split('/')[0] || '').toLowerCase();
}

function domainOf(section) {
  return DOMAIN_BY_SECTION[section] || 'system';
}

function neededLevel(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase()) ? 'read' : 'write';
}

/** Уровень доступа роли к домену. */
function levelFor(role, domain) {
  const def = ROLES[normalizeRole(role)];
  const raw = (def.domains && def.domains[domain]) || def.all || 'none';
  return LEVELS[raw] === undefined ? 'none' : raw;
}

/**
 * Главная проверка.
 * @returns {{allowed:boolean, role:string, section:string, domain:string,
 *            need:string, have:string, message?:string}}
 */
function check(role, method, pathname) {
  const canonical = normalizeRole(role);
  const section = sectionOf(pathname);
  const domain = domainOf(section);
  const need = neededLevel(method);

  if (ALWAYS_ALLOWED_SECTIONS.has(section)) {
    return { allowed: true, role: canonical, section, domain: 'auth', need, have: 'write' };
  }

  const have = levelFor(canonical, domain);
  const allowed = LEVELS[have] >= LEVELS[need];
  const title = DOMAIN_TITLES[domain] || domain;

  return {
    allowed, role: canonical, section, domain, need, have,
    message: allowed ? undefined : (have === 'none'
      ? 'Роль «' + ROLES[canonical].title + '» не имеет доступа к разделу «' + title + '»'
      : 'Роль «' + ROLES[canonical].title + '» может только читать раздел «' + title + '»')
  };
}

/** Карта доменов для фронта и для /auth/me. */
function permissionsFor(role) {
  const canonical = normalizeRole(role);
  const out = {};
  for (const d of DOMAINS) out[d] = levelFor(canonical, d);
  return out;
}

/**
 * Права в виде строк «домен:уровень». У владельца — `*`: фронт админки
 * понимает эту звёздочку как «всё разрешено».
 */
function permissionListFor(role) {
  const canonical = normalizeRole(role);
  if (canonical === 'SUPER_ADMIN') return ['*'];
  return Object.entries(permissionsFor(canonical))
    .filter(([, lvl]) => lvl !== 'none')
    .map(([d, lvl]) => d + ':' + lvl);
}

/** Описание ролей для экрана управления администраторами. */
function roleCatalog() {
  return ROLE_NAMES.map(name => ({
    name,
    title: ROLES[name].title,
    note: ROLES[name].note,
    permissions: permissionsFor(name)
  }));
}

module.exports = {
  LEVELS, ROLES, ROLE_NAMES, DOMAINS, DOMAIN_TITLES, DOMAIN_BY_SECTION, DEFAULT_ROLE,
  normalizeRole, sectionOf, domainOf, neededLevel, levelFor,
  check, permissionsFor, permissionListFor, roleCatalog
};
