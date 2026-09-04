'use strict';
const { ensureColumns } = require('./schemaCompatibility');
const { transaction: sqliteTransaction } = require('../../services/sqliteTransaction');

const money = value => Number(value || 0).toFixed(2);
function iso(value) {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function register({ app, dbAll, dbGet, dbRun, requireAdminJWT, DB_PATH,
  getAdminDb = () => new (require('sqlite3').Database)(DB_PATH || require('path').join(__dirname,'database.sqlite')) }) {
  const deposits = require('../../services/deposits').makeDepositsService({queryAdminDb:dbAll,getAdminDb});
  let schemaReady;
  function ensureSchema() {
    if (!schemaReady) schemaReady = ensureColumns({ all: dbAll, run: dbRun }, 'users')
      .catch(error => { schemaReady = undefined; throw error; });
    return schemaReady;
  }
  const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });
  const fail = (res, status, message) => res.status(status).json({ success: false, message });
  const handle = fn => async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (error) {
      const status = Number(error?.status) || 500;
      if (status === 500) console.error('[Users]', error);
      fail(res, status, error?.status ? error.message : 'Не удалось обработать запрос пользователя');
    }
  };
  const columns = `u.id, u.username, u.steam_id, u.role, u.status, u.balance, u.created_at,
    u.last_login_at, u.email, u.email_verified, u.avatar, u.profile_url, u.trade_link`;
  const dto = row => ({
    userId: String(row.id), username: row.username, avatar: row.avatar,
    role: String(row.role || 'user').toUpperCase(), status: row.status,
    steamLevel: null, createdAt: iso(row.created_at), updatedAt: iso(row.last_login_at || row.created_at),
    profileUrl: row.profile_url || null, tradeUrl: row.trade_link || null,
    email: row.email || null, emailVerified: Boolean(row.email_verified),
    balance: money(row.balance), identities: [
      ...(row.steam_id ? [{ provider: 'steam', externalId: row.steam_id }] : []),
      ...(row.email ? [{ provider: 'email', externalId: row.email }] : [])
    ]
  });
  async function user(req, res) {
    const id = req.params.id;
    if (!/^[1-9]\d*$/.test(id)) { fail(res, 404, 'Пользователь не найден'); return null; }
    const row = await dbGet(`SELECT ${columns} FROM users u WHERE u.id = ?`, [id]);
    if (!row) fail(res, 404, 'Пользователь не найден');
    return row;
  }
  const forUser = fn => handle(async (req, res) => {
    const row = await user(req, res);
    if (row) await fn(req, res, row);
  });
  const pageOf = query => ({ page: Math.max(1, parseInt(query.page, 10) || 1), limit: Math.min(500, Math.max(1, parseInt(query.limit, 10) || 20)) });

  app.get('/api/v1/admin/users', requireAdminJWT, handle(async (req, res) => {
    const q = req.query, where = [], params = [];
    if (q.search) {
      where.push('(u.username LIKE ? OR CAST(u.id AS TEXT) = ? OR u.steam_id = ? OR u.email LIKE ?)');
      params.push(`%${q.search}%`, q.search, q.search, `%${q.search}%`);
    }
    if (q.roles) {
      const roles = (Array.isArray(q.roles) ? q.roles : [q.roles]).map(r => String(r).toLowerCase());
      where.push(`LOWER(u.role) IN (${roles.map(() => '?').join(',')})`); params.push(...roles);
    }
    if (q.status) { where.push('u.status = ?'); params.push(q.status); }
    if (q.emailVerified !== undefined) { where.push('COALESCE(u.email_verified,0) = ?'); params.push(q.emailVerified === 'true' ? 1 : 0); }
    if (q.linkedProvider === 'steam') where.push("COALESCE(u.steam_id,'') <> ''");
    else if (q.linkedProvider === 'email') where.push("COALESCE(u.email,'') <> ''");
    else if (q.linkedProvider) return fail(res, 400, 'Этот провайдер не подключён');
    for (const [key, column, op] of [
      ['createdFrom', 'u.created_at', '>='], ['createdTo', 'u.created_at', '<='],
      ['updatedFrom', 'COALESCE(u.last_login_at,u.created_at)', '>='], ['updatedTo', 'COALESCE(u.last_login_at,u.created_at)', '<=']
    ]) if (q[key]) {
      if (!iso(q[key])) return fail(res, 400, 'Некорректная дата');
      where.push(`julianday(${column}) ${op} julianday(?)`); params.push(q[key]);
    }
    for (const [key, op] of [['balanceMin', '>='], ['balanceMax', '<=']]) if (q[key] !== undefined) {
      if (!Number.isFinite(Number(q[key]))) return fail(res, 400, 'Некорректная сумма');
      where.push(`u.balance ${op} ?`); params.push(Number(q[key]));
    }
    // Do not pretend unsupported filters have been applied.
    const unavailable = ['steamLevelMin','steamLevelMax','depositBlocked','withdrawBlocked','betBlocked','kycRequired',
      'isAdult','hasAcceptedTos','ladderVariant','ladderActive','depositsMin','depositsMax','withdrawalsMin','withdrawalsMax',
      'ggrMin','ggrMax','ngrMin','ngrMax','bonusMin','bonusMax','hasDeposits','kycStatus'];
    const unsupported = unavailable.filter(key => q[key] !== undefined && q[key] !== '');
    if (unsupported.length) return fail(res, 400, `Фильтры пока не поддерживаются источником данных: ${unsupported.join(', ')}`);
    const order = { username: 'u.username', created_at: 'u.created_at', updated_at: 'COALESCE(u.last_login_at,u.created_at)' }[q.sortBy] || 'u.id';
    const direction = q.sortDir === 'asc' ? 'ASC' : 'DESC';
    const { page, limit } = pageOf(q);
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = (await dbGet(`SELECT COUNT(*) AS total FROM users u${clause}`, params)).total;
    const rows = await dbAll(`SELECT ${columns} FROM users u${clause} ORDER BY ${order} ${direction}, u.id ${direction} LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    ok(res, rows.map(dto), { total, pagination: { total, page, limit } });
  }));

  const kycDto = row => ({ id: String(row.id), userId: String(row.user_id), status: String(row.status).toUpperCase(),
    levelName: row.levelName || null, createdAt: iso(row.created_at), reviewedAt: iso(row.reviewed_at) });
  const kycQuery = 'SELECT k.*, l.title AS levelName FROM kyc_requests k LEFT JOIN kyc_levels l ON l.level = k.level';
  app.get('/api/v1/admin/kyc/levels', requireAdminJWT, handle(async (req,res) => {
    const levels = await dbAll('SELECT * FROM kyc_levels ORDER BY level');
    ok(res,{ levels: levels.map(r=>({ id:String(r.id), name:r.title, isActive:Boolean(r.enabled), level:r.level })) });
  }));
  app.get('/api/v1/admin/kyc', requireAdminJWT, handle(async (req,res) => {
    const { page,limit } = pageOf(req.query), args = [];
    const where = req.query.status ? ' WHERE LOWER(k.status) = ?' : '';
    if (req.query.status) args.push(String(req.query.status).toLowerCase());
    const total = (await dbGet('SELECT COUNT(*) AS total FROM kyc_requests k'+where,args)).total;
    const rows = await dbAll(kycQuery+where+' ORDER BY k.id DESC LIMIT ? OFFSET ?', [...args,limit,(page-1)*limit]);
    ok(res,rows.map(kycDto),{ total,pagination:{ total,page,limit } });
  }));
  app.put('/api/v1/admin/kyc/:id', requireAdminJWT, handle(async (req,res) => {
    const row = await dbGet('SELECT * FROM kyc_requests WHERE id = ?', [req.params.id]);
    if (!row) return fail(res,404,'Заявка KYC не найдена');
    const status = String(req.body?.status || '').toLowerCase();
    if (!['none','required','pending','approved','rejected'].includes(status)) return fail(res,400,'Некорректный статус KYC');
    let level = row.level;
    if (req.body.levelName !== undefined) {
      if (req.body.levelName === '') level = null;
      else {
        const found = await dbGet('SELECT level FROM kyc_levels WHERE title = ? AND enabled = 1',[req.body.levelName]);
        if (!found) return fail(res,400,'Уровень KYC не найден или отключён');
        level = found.level;
      }
    }
    await dbRun('UPDATE kyc_requests SET status = ?, level = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?', [status,level,row.id]);
    ok(res,kycDto(await dbGet(kycQuery+' WHERE k.id = ?',[row.id])));
  }));

  app.get('/api/v1/admin/users/:id', requireAdminJWT, forUser(async (req, res, row) => {
    const kyc = await dbGet('SELECT status, level FROM kyc_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1', [row.id]);
    const level = kyc ? await dbGet('SELECT title FROM kyc_levels WHERE level = ?', [kyc.level]) : null;
    ok(res, { user: { ...dto(row), kycStatus: String(kyc?.status || 'NONE').toUpperCase(), kycLevelName: level?.title || null } });
  }));

  async function ledger(id) { return dbAll('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC', [id]); }
  function transaction(row) {
    return { id: String(row.id), type: row.type, amount: money(row.amount), reason: row.comment, createdAt: iso(row.created_at) };
  }
  app.get('/api/v1/admin/wallet/:id([0-9]+)', requireAdminJWT, forUser(async (req, res, row) => {
    const state=await hasTable('wallet_wagers') ? await dbGet('SELECT remaining_cents FROM wallet_wagers WHERE user_id=?',[row.id]) : null;
    ok(res, { wallet: { userId: String(row.id), balance: money(row.balance), wager: {
      remaining:money(Number(state?.remaining_cents||0)/100),hasActiveWager:Number(state?.remaining_cents||0)>0},
      recentTransactions: (await ledger(row.id)).slice(0,50).map(transaction) } });
  }));
  for(const route of ['/wallet/:id/adjust','/wallet/:id/manual-deposit']) {
    app.post('/api/v1/admin'+route,requireAdminJWT,forUser(async(req,res,row)=>{
      if (req.user?.role !== 'SUPER_ADMIN') return fail(res,403,'Корректировка доступна только SUPER_ADMIN');
      if (req.body?.action && req.body.action!=='CREDIT') return fail(res,501,'Ручное списание пока не подключено. Баланс не изменён.');
      const result=await deposits.manualCredit({...req.body,userId:row.id,by:'admin:'+req.user.userId});
      if (!result.ok) return fail(res,result.error==='IDEMPOTENCY_CONFLICT'?409:400,result.message);
      const balance=await dbGet('SELECT balance FROM users WHERE id=?',[row.id]);
      ok(res,{newBalance:money(balance.balance),deposit:result.deposit,replayed:Boolean(result.replayed),wager:await deposits.wager(row.id)});
    }));
  }
  const betTypes = ['case_open', 'battle_entry', 'upgrade'];
  const winTypes = ['case_win', 'battle_win', 'upgrade_win'];
  const hasTable = async name => Boolean(await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name]));
  function history(req,res,items) {
    const {page,limit}=pageOf(req.query);
    const from=req.query.from ? iso(req.query.from) : null, to=req.query.to ? iso(req.query.to) : null;
    if ((req.query.from&&!from)||(req.query.to&&!to)||(from&&to&&from>to)) return fail(res,400,'Некорректный период');
    const filtered=items.filter(r=>(!from||r.createdAt>=from)&&(!to||r.createdAt<=to))
      .sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||String(b.id).localeCompare(String(a.id),undefined,{numeric:true}));
    ok(res,{items:filtered.slice((page-1)*limit,page*limit),total:filtered.length,page,limit});
  }
  app.get('/api/v1/admin/wallet/:id/bets',requireAdminJWT,forUser(async(req,res,row)=>{
    const types={case_open:'CASE',upgrade:'UPGRADER',battle_entry:'BATTLE'};
    const rows=(await ledger(row.id)).filter(r=>betTypes.includes(r.type));
    history(req,res,rows.map(r=>({id:String(r.id),type:types[r.type],betAmount:money(Math.abs(r.amount)),
      winAmount:null,multiplier:null,houseEdge:null,isFree:false,caseName:null,
      createdAt:iso(r.created_at),resultKnown:false,description:r.comment||'',source:'transactions'})));
  }));
  app.get('/api/v1/admin/wallet/:id/deposits',requireAdminJWT,forUser(async(req,res,row)=>{
    const deposits=await hasTable('deposits') ? await dbAll('SELECT * FROM deposits WHERE user_id=?',[row.id]) : [];
    const entries=deposits.map(r=>({id:String(r.uid||r.id),amount:money(r.amount),
      creditedAmount:money(r.credited),promoBonusAmount:'0.00',conversionRate:null,
      status:{paid:'COMPLETED',pending:'PENDING',rejected:'FAILED',expired:'EXPIRED',failed:'FAILED'}[r.status]||r.status,
      provider:r.provider||r.method||null,methodCategory:r.method,asset:r.asset,network:r.network,
      comment:r.comment||'',createdAt:iso(r.created_at),updatedAt:iso(r.settled_at||r.created_at),
      grossAmount:money(r.amount),commissionAmount:null,txHash:r.provider_ref||null}));
    const credits=(await ledger(row.id)).filter(r=>r.type==='deposit' && !deposits.some(d=>d.uid&&String(r.comment).includes('№'+d.uid)));
    for(const r of credits) entries.push({id:'ledger-'+r.id,amount:money(r.amount),creditedAmount:money(r.amount),
      promoBonusAmount:'0.00',conversionRate:null,status:'COMPLETED',provider:'Журнал операций',methodCategory:'legacy',
      comment:r.comment||'',createdAt:iso(r.created_at),updatedAt:iso(r.created_at),grossAmount:money(r.amount),commissionAmount:null});
    history(req,res,entries);
  }));
  app.get('/api/v1/admin/deposit-chain/users/:id',requireAdminJWT,forUser(async(req,res,row)=>{
    const claims=await hasTable('deposit_chain_claims') ? await dbAll('SELECT * FROM deposit_chain_claims WHERE user_id=? ORDER BY tier_index',[row.id]) : [];
    const deposited=(await ledger(row.id)).filter(r=>r.type==='deposit').reduce((n,r)=>n+Number(r.amount),0);
    let tiers=[{threshold:0},{threshold:174},{threshold:384},{threshold:821},{threshold:1166}];
    if(await hasTable('app_settings')) {
      const config=await dbGet("SELECT value FROM app_settings WHERE key='deposit_chain'");
      if(config?.value){const parsed=JSON.parse(config.value);if(Array.isArray(parsed.tiers)&&parsed.tiers.length)tiers=parsed.tiers;}
    }
    ok(res,{enrolled:true,variant:'A',enteredAt:iso(row.created_at),hasDepositsAtEntry:null,
      totalDeposited:money(deposited),completed:tiers.every((_,i)=>claims.some(c=>c.tier_index===i)),qaEnrollmentAvailable:false,
      claims:claims.map(c=>({tierIndex:c.tier_index,status:c.status,caseOpeningId:null,openedAt:iso(c.opened_at),adminUserId:c.admin_user_id||null})),
      source:'shared_database',enrollmentModel:'all_registered_users'});
  }));
  app.post('/api/v1/admin/deposit-chain/users/:id/enroll',requireAdminJWT,forUser(async(req,res)=>{
    fail(res,404,'QA-зачисление отключено: на сайте лестница доступна всем зарегистрированным пользователям');
  }));
  app.post('/api/v1/admin/deposit-chain/users/:id/claims/:tierIndex/void',requireAdminJWT,forUser(async(req,res,row)=>{
    if(req.user?.role!=='SUPER_ADMIN')return fail(res,403,'Аннулирование доступно только SUPER_ADMIN');
    const index=Number(req.params.tierIndex),reason=typeof req.body?.reason==='string'?req.body.reason.trim():'';
    if(!Number.isInteger(index)||index<0||!reason||reason.length>128)return fail(res,400,'Укажите тир и причину длиной до 128 символов');
    if(!await hasTable('deposit_chain_claims'))return fail(res,404,'Открытие не найдено');
    const claim=await dbGet('SELECT * FROM deposit_chain_claims WHERE user_id=? AND tier_index=?',[row.id,index]);
    if(!claim)return fail(res,404,'Открытие не найдено');
    if(!['CONSUMED','CLAIMED'].includes(claim.status))return fail(res,409,'Открытие уже обработано');
    await dbRun("UPDATE deposit_chain_claims SET status='VOIDED',admin_user_id=?,void_reason=? WHERE user_id=? AND tier_index=? AND status IN ('CONSUMED','CLAIMED')",
      [String(req.user.userId),reason,row.id,index]);
    ok(res,{tierIndex:index,status:'VOIDED',prizeReversed:false});
  }));
  app.get('/api/v1/admin/wallet/:id/financial-stats', requireAdminJWT, forUser(async (req, res, row) => {
    const rows = await ledger(row.id);
    const select = types => rows.filter(r => types.includes(r.type));
    const total = values => values.reduce((sum, r) => sum + Math.abs(Number(r.amount)), 0);
    const deposits = select(['deposit']), bets = select(betTypes), wins = select(winTypes), withdrawals = select(['withdraw', 'withdrawal']);
    const bonuses = select(['deposit_bonus']);
    ok(res, { depositCount: deposits.length, depositTotal: money(total(deposits)),
      depositBonusCount: bonuses.length, depositBonusTotal: money(total(bonuses)),
      withdrawalCount: withdrawals.length, withdrawalTotal: money(total(withdrawals)),
      betCount: bets.length, betTotal: money(total(bets)), winTotal: money(total(wins)),
      ggr: money(total(bets) - total(wins)), activeDays: new Set(rows.map(r => iso(r.created_at)?.slice(0,10)).filter(Boolean)).size });
  }));

  app.get('/api/v1/admin/users/:id/game-stats', requireAdminJWT, forUser(async (req, res, row) => {
    const rows = await ledger(row.id);
    const stats = [];
    for (const [game, bet, win] of [['case','case_open','case_win'],['battle','battle_entry','battle_win'],['upgrade','upgrade','upgrade_win']]) {
      const bets = rows.filter(r => r.type === bet), wins = rows.filter(r => r.type === win && Number(r.amount) > 0);
      if (!bets.length && !wins.length) continue;
      const wagered = bets.reduce((sum,r) => sum + Math.abs(Number(r.amount)),0), won = wins.reduce((sum,r) => sum + Number(r.amount),0);
      stats.push({ game, games: bets.length, wins: wins.length, losses: Math.max(0,bets.length-wins.length),
        winrate: bets.length ? money(100*wins.length/bets.length) : null, wagered: money(wagered), won: money(won), ggr: money(wagered-won) });
    }
    ok(res, { stats, source: 'transactions' });
  }));
  app.get('/api/v1/admin/wallet/:id/balance-history', requireAdminJWT, forUser(async (req, res, row) => {
    const granularity = req.query.granularity || 'day';
    if (!['day','hour'].includes(granularity)) return fail(res, 400, 'Некорректный интервал');
    const from = req.query.from ? iso(req.query.from) : null, to = req.query.to ? iso(req.query.to) : null;
    if ((req.query.from && !from) || (req.query.to && !to)) return fail(res,400,'Некорректная дата');
    const buckets = new Map();
    for (const entry of await ledger(row.id)) {
      const timestamp = iso(entry.created_at);
      if (!timestamp || (from && timestamp < from) || (to && timestamp > to)) continue;
      const key = timestamp.slice(0, granularity === 'hour' ? 13 : 10);
      if (!buckets.has(key)) buckets.set(key,{ bucket:key, deposits:0, withdrawals:0, betProfit:0 });
      const bucket = buckets.get(key), amount = Number(entry.amount);
      if (entry.type === 'deposit') bucket.deposits += amount;
      if (['withdraw','withdrawal'].includes(entry.type)) bucket.withdrawals += Math.abs(amount);
      if (betTypes.includes(entry.type) || winTypes.includes(entry.type)) bucket.betProfit += amount;
    }
    ok(res,{ buckets:[...buckets.values()].sort((a,b)=>a.bucket.localeCompare(b.bucket)).map(b=>({
      bucket:b.bucket, deposits:money(b.deposits), withdrawals:money(b.withdrawals), betProfit:money(b.betProfit)
    })) });
  }));

  const assignableRoles = new Set(['USER', 'STREAMER', 'CURR_MANAGER']);
  app.patch('/api/v1/admin/users/:id/role', requireAdminJWT, forUser(async (req, res, row) => {
    if (req.user?.role !== 'SUPER_ADMIN') return fail(res, 403, 'Смена роли доступна только SUPER_ADMIN');
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toUpperCase() : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!assignableRoles.has(role)) return fail(res, 400, 'Можно назначить только USER, STREAMER или CURR_MANAGER');
    if (!reason || reason.length > 500) return fail(res, 400, 'Укажите причину смены роли длиной до 500 символов');

    const result = await sqliteTransaction(getAdminDb, async tx => {
      await tx.run(`CREATE TABLE IF NOT EXISTS user_role_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        old_role TEXT NOT NULL, new_role TEXT NOT NULL, reason TEXT NOT NULL,
        admin_user_id TEXT NOT NULL, changed_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      const current = await tx.get('SELECT role FROM users WHERE id = ?', [row.id]);
      if (!current) {
        const error = new Error('Пользователь не найден'); error.status = 404; throw error;
      }
      const oldRole = String(current.role || 'user').toUpperCase();
      if (!assignableRoles.has(oldRole)) {
        const error = new Error('Административные роли меняются в разделе сотрудников'); error.status = 409; throw error;
      }
      if (oldRole === role) return { changed: false, oldRole };
      await tx.run('UPDATE users SET role = ? WHERE id = ?', [role.toLowerCase(), row.id]);
      await tx.run(`INSERT INTO user_role_history (user_id,old_role,new_role,reason,admin_user_id)
        VALUES (?,?,?,?,?)`, [row.id, oldRole, role, reason, String(req.user.userId)]);
      return { changed: true, oldRole };
    });
    ok(res, { user: dto({ ...row, role: role.toLowerCase() }), changed: result.changed });
  }));

  // These controls previously returned fake success. Keep them explicit until the
  // shared financial/security services implement the operation end to end.
  for (const [method, route] of [
    ['put','/users/:id/analytics-exclusion'],
    ['get','/rtp/users/:id/tier'], ['put','/rtp/users/:id/tier'], ['post','/rtp/users/:id/tier/reset'],
    ['post','/deposit-chain/users/:id/enroll'], ['post','/deposit-chain/users/:id/claims/:tierIndex/void']
  ]) app[method]('/api/v1/admin'+route, requireAdminJWT, forUser(async (req,res) => {
    fail(res,501,'Операция ещё не подключена к сервису сайта. Изменения не выполнены.');
  }));

  let auditReady;
  function ensureAudit() {
    if (!auditReady) auditReady = (async () => {
      await dbRun(`CREATE TABLE IF NOT EXISTS user_username_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
        old_username TEXT, new_username TEXT, changed_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
      // SQLite trigger keeps the rename and its history in the same transaction.
      await dbRun(`CREATE TRIGGER IF NOT EXISTS user_username_history_update AFTER UPDATE OF username ON users
        WHEN OLD.username IS NOT NEW.username BEGIN
          INSERT INTO user_username_history (user_id,old_username,new_username) VALUES (NEW.id,OLD.username,NEW.username);
        END`);
    })().catch(error => { auditReady = undefined; throw error; });
    return auditReady;
  }
  app.put('/api/v1/admin/users/:id/display-name', requireAdminJWT, forUser(async (req, res, row) => {
    const name = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    if (name.length < 3 || name.length > 32 || /[\x00-\x1f\x7f]/.test(name)) return fail(res, 400, 'Ник должен быть от 3 до 32 символов');
    await ensureAudit();
    await dbRun('UPDATE users SET username = ? WHERE id = ?', [name, row.id]);
    ok(res, { user: dto({ ...row, username: name }) });
  }));
  app.get('/api/v1/admin/users/:id/username-history', requireAdminJWT, forUser(async (req, res, row) => {
    await ensureAudit();
    const entries = await dbAll('SELECT old_username,new_username,changed_at FROM user_username_history WHERE user_id = ? ORDER BY id DESC', [row.id]);
    ok(res, { entries: entries.map(r => ({ oldUsername: r.old_username, newUsername: r.new_username, changedAt: iso(r.changed_at) })) });
  }));
}

module.exports = { register };
