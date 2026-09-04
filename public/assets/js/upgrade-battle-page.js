import {a as defineComponent, r as ref, N as onMounted, a7 as onUnmounted, s as h} from './vendor-vNcy1sFx.js';
import {c as request} from './mutator-DePLmT3f.js';
import {u as useUserStore} from './store-CliSAPz5.js';
import {u as useAuthStore} from './store-DveOaq2e.js';

// Readable companion to the compiled lobby. Keep this module when rebuilding the SPA.
const BASE = '/upgrade-battles';
const lobbyUrl = '/crate-pvp?mode=upgrade';
const roomUrl = uid => `${lobbyUrl}&battle=${encodeURIComponent(uid)}`;
const money = value => Number(value).toLocaleString('ru-RU', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' ₽';
const percent = value => (Number(value) * 100).toLocaleString('ru-RU', {maximumFractionDigits: 2}) + '%';
const amount = value => Number(String(value).trim().replace(',', '.'));
const validMoney = value => Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < .00001;
const statusText = status => ({waiting: 'Ожидает соперника', finished: 'Завершён', cancelled: 'Отменён'}[status] || 'Неизвестный статус');
const imageUrl = value => typeof value === 'string' && (/^\/(?!\/)/.test(value) || /^https?:\/\//i.test(value)) ? value : '';

function apiData(response) {
  if (response?.status !== 'success' || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    throw new Error('Сервер вернул неверный ответ. Обновите страницу или повторите запрос.');
  }
  return response.data;
}
function checkedRoom(battle) {
  if (!battle?.uid || !['waiting', 'finished', 'cancelled'].includes(battle.status) ||
      !Array.isArray(battle.targets) || battle.targets.length !== 3 ||
      !battle.targets.every(t => t && validMoney(Number(t.price)) && Number.isFinite(t.chance)) ||
      !Array.isArray(battle.players) || !battle.players.length || !Array.isArray(battle.rounds) ||
      !validMoney(Number(battle.entryPrice))) throw new Error('Не удалось прочитать данные батла. Повторите загрузку.');
  return battle;
}
function errorText(error) {
  if (error?.response?.status === 401) return 'Нужно войти в аккаунт. После входа повторите действие.';
  return error?.response?.data?.message || error?.response?.data?.error?.message || error?.message || 'Не удалось связаться с сервером. Повторите запрос.';
}

export function createBattleModel({request: send = request, uuid = () => crypto.randomUUID(),
  navigate = url => window.history.replaceState({...window.history.state, current: url}, '', url), refreshBalance = async () => {},
  search = window.location.search} = {}) {
  const state = ref({config: null, battles: [], battle: null, loading: false, loaded: false,
    busy: false, error: '', notice: '', history: false, roundBet: 100, selected: [],
    searchText: '', minPrice: '', maxPrice: '', items: [], total: 0, searching: false,
    itemError: '', confirmation: null, visibleRounds: 3});
  let uid = new URLSearchParams(search).get('battle');
  let disposed = false, pollTimer = null, animationTimer = null, searchVersion = 0, loadVersion = 0;
  const timers = new Set();
  // The shared auth interceptor can leave a 401 unresolved while showing login.
  // Bound the UI wait, but never issue an automatic POST retry after a timeout.
  async function call(options) {
    const pending = send(options);
    let timer;
    try {
      return apiData(await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => { pending.cancel?.(); reject(new Error('Нет ответа от сервера. Возможно, нужна авторизация. Повторите тот же запрос после входа.')); }, 20000);
        timers.add(timer);
      })]));
    } finally { clearTimeout(timer); timers.delete(timer); }
  }
  function stopPoll() { clearTimeout(pollTimer); pollTimer = null; }
  function schedulePoll() {
    stopPoll();
    if (!disposed && !state.value.confirmation && (!uid || state.value.battle?.status === 'waiting')) {
      pollTimer = setTimeout(() => load(true), 3000);
      pollTimer?.unref?.();
    }
  }
  function showBattle(battle, animate = false) {
    const s = state.value;
    s.battle = checkedRoom(battle);
    clearTimeout(animationTimer);
    s.visibleRounds = animate && battle.status === 'finished' ? 0 : 3;
    if (s.visibleRounds === 0) {
      const reveal = () => {
        if (disposed) return;
        s.visibleRounds++;
        if (s.visibleRounds < 3) animationTimer = setTimeout(reveal, 1100);
      };
      animationTimer = setTimeout(reveal, 1100);
    }
  }
  async function load(silent = false) {
    if (disposed || state.value.busy) { schedulePoll(); return; }
    const version = ++loadVersion, s = state.value;
    if (!silent) { s.loading = true; s.error = ''; }
    try {
      const data = await call({url: uid ? `${BASE}/${encodeURIComponent(uid)}` : BASE, method: 'GET',
        ...(!uid ? {params: {history: s.history ? 'true' : 'false'}} : {})});
      if (disposed || version !== loadVersion) return;
      if (uid) {
        const previousStatus = s.battle?.status;
        showBattle(data.battle, previousStatus === 'waiting' && data.battle?.status === 'finished');
        if (previousStatus === 'waiting' && s.battle.status !== 'waiting') refreshBalance().catch(() => {});
      } else {
        if (!Array.isArray(data.battles) || typeof data.config?.enabled !== 'boolean') throw new Error('Не удалось загрузить список батлов.');
        s.battles = data.battles.map(checkedRoom); s.config = data.config;
      }
      s.loaded = true; s.error = '';
    } catch (error) { if (!disposed && version === loadVersion) s.error = errorText(error); }
    finally { if (!disposed && version === loadVersion) { s.loading = false; schedulePoll(); } }
  }
  async function searchItems() {
    const version = ++searchVersion, s = state.value;
    s.searching = true; s.itemError = '';
    try {
      const params = {search: s.searchText.trim()};
      for (const field of ['minPrice', 'maxPrice']) {
        if (String(s[field]).trim() !== '') {
          params[field] = amount(s[field]);
          if (!Number.isFinite(params[field]) || params[field] < 0 || params[field] > 100000000) throw new Error('Цена должна быть числом от 0 до 100 000 000.');
        }
      }
      if (params.minPrice != null && params.maxPrice != null && params.minPrice > params.maxPrice) throw new Error('Цена «от» не может быть выше цены «до».');
      const data = await call({url: `${BASE}/items`, method: 'GET', params});
      if (disposed || version !== searchVersion) return;
      if (!Array.isArray(data.items) || !Number.isFinite(data.total)) throw new Error('Неверный ответ каталога предметов.');
      s.items = data.items; s.total = data.total;
    } catch (error) { if (!disposed && version === searchVersion) { s.itemError = errorText(error); s.items = []; } }
    finally { if (!disposed && version === searchVersion) s.searching = false; }
  }
  const formLocked = () => state.value.busy || !!state.value.confirmation;
  function prepareCreate() {
    const s = state.value;
    if (formLocked()) return;
    s.error = '';
    const bet = amount(s.roundBet), c = s.config;
    if (!c?.enabled) { s.error = 'Режим временно выключен.'; return; }
    if (!validMoney(bet) || bet < c.minRoundBet || bet > c.maxRoundBet) { s.error = `Ставка за раунд: от ${money(c.minRoundBet)} до ${money(c.maxRoundBet)}, не более двух знаков после запятой.`; return; }
    if (s.selected.length !== 3 || !s.selected.every(t => Number.isSafeInteger(t.id) && t.id > 0)) { s.error = 'Выберите ровно три цели — по одной на каждый раунд.'; return; }
    if (!s.selected.every(t => { const price = Number(t.price), chance = bet / price * c.rtp;
      return validMoney(price) && price > bet && chance >= .01 && chance <= .95;
    })) { s.error = 'Каждая цель должна стоить больше ставки за раунд. Допустимый шанс: 1–95%.'; return; }
    s.confirmation = {kind: 'create', price: Math.round(bet * 100) * 3 / 100,
      targets: s.selected.map(t => ({...t, chance: bet / Number(t.price) * c.rtp})), attempted: false,
      payload: {requestId: uuid(), roundBet: bet, targetIds: s.selected.map(t => t.id), clientSeed: uuid()}};
  }
  function prepareJoin() {
    const s = state.value, b = s.battle;
    if (formLocked() || !b || b.status !== 'waiting' || b.viewerIsPlayer || b.viewerIsCreator) return;
    s.error = ''; s.confirmation = {kind: 'join', uid: b.uid, price: b.entryPrice, targets: b.targets,
      attempted: false, payload: {clientSeed: uuid()}};
  }
  function prepareCancel() {
    const s = state.value, b = s.battle;
    if (formLocked() || !b?.viewerIsCreator || b.status !== 'waiting') return;
    s.error = ''; s.confirmation = {kind: 'cancel', uid: b.uid, price: b.entryPrice, attempted: false, payload: {}};
  }
  function newForm() {
    if (state.value.busy) return;
    state.value.confirmation = null; state.value.error = '';
    schedulePoll();
  }
  async function confirm() {
    const s = state.value, confirmation = s.confirmation;
    if (!confirmation || s.busy || disposed) return;
    s.busy = true; s.error = ''; confirmation.attempted = true;
    stopPoll(); ++loadVersion;
    try {
      const url = confirmation.kind === 'create' ? `${BASE}/create` : `${BASE}/${encodeURIComponent(confirmation.uid)}/${confirmation.kind}`;
      const data = await call({url, method: 'POST', data: confirmation.payload});
      if (disposed) return;
      showBattle(data.battle, confirmation.kind === 'join');
      uid = s.battle.uid; s.loaded = true; s.confirmation = null;
      navigate(roomUrl(uid));
      // Failure of a balance refresh must never turn a successful wager into a retry.
      try { await refreshBalance(); } catch { s.notice = 'Батл сохранён. Обновите страницу, чтобы обновить баланс.'; }
    } catch (error) { if (!disposed) s.error = errorText(error); }
    finally { if (!disposed) { s.busy = false; s.loading = false; schedulePoll(); } }
  }
  function dispose() {
    disposed = true; ++loadVersion; ++searchVersion; stopPoll(); clearTimeout(animationTimer);
    for (const timer of timers) clearTimeout(timer); timers.clear();
  }
  return {state, load, searchItems, prepareCreate, prepareJoin, prepareCancel, confirm, formLocked, newForm, dispose};
}

function ensureStyles() {
  if (document.getElementById('upgrade-battle-style')) return;
  const link = document.createElement('link');
  link.id = 'upgrade-battle-style'; link.rel = 'stylesheet'; link.href = '/assets/css/upgrade-battle.css';
  document.head.appendChild(link);
}
const button = (label, onClick, disabled = false, primary = false) => h('button', {type: 'button', class: primary ? 'ub-button ub-primary' : 'ub-button', disabled, onClick}, label);
const itemImage = (item, className = 'ub-skin') => imageUrl(item?.image) ? h('img', {class: className, src: imageUrl(item.image), alt: '', loading: 'lazy', onError: event => { event.target.hidden = true; }}) : h('span', {class: className, 'aria-hidden': 'true'}, '◇');

export const UpgradeBattlePage = defineComponent({
  name: 'UpgradeBattlePage',
  setup() {
    const user = useUserStore(), auth = useAuthStore();
    const model = createBattleModel({refreshBalance: () => user.fetchUserData()});
    const s = model.state;
    const paidAction = action => () => {
      if (!auth.isAuthenticated) { s.value.error = 'Нужно войти в аккаунт для участия.'; auth.openAuthModal?.(); return; }
      action();
    };
    onMounted(() => { ensureStyles(); model.load(); });
    onUnmounted(model.dispose);
    function field(label, key, options = {}) {
      return h('label', {class: 'ub-field'}, [h('span', null, label), h('input', {
        type: 'text', ...options, value: s.value[key], disabled: model.formLocked(),
        onInput: event => { s.value[key] = event.target.value; }
      })]);
    }
    function targetCard(target, index, removable = false) {
      return h('article', {class: 'ub-target', key: index, 'data-rarity': target.rarity}, [
        h('span', {class: 'ub-muted'}, `Раунд ${index + 1}`), itemImage(target),
        h('strong', null, target.name), h('span', null, money(target.price)),
        h('small', {class: 'ub-muted'}, `Шанс: ${percent(target.chance)}`),
        removable ? button('Убрать', () => s.value.selected.splice(index, 1), model.formLocked()) : null
      ]);
    }
    function creation() {
      const state = s.value, c = state.config;
      if (!c) return null;
      if (!c.enabled) return h('section', {class: 'ub-panel'}, 'Новые апгрейд-батлы временно выключены. История и возврат взноса остаются доступны.');
      return h('section', {class: 'ub-panel'}, [h('h2', null, 'Создать апгрейд-батл'),
        h('p', {class: 'ub-muted'}, `1 на 1 · 3 раунда · RTP ${percent(c.rtp)} · ожидание ${Math.round(c.waitSeconds / 60)} мин.`),
        field('Ставка за один раунд, ₽', 'roundBet', {inputmode: 'decimal'}),
        h('p', null, `Взнос за три раунда: ${validMoney(amount(state.roundBet)) ? money(Math.round(amount(state.roundBet) * 100) * 3 / 100) : '—'}`),
        h('div', {class: 'ub-targets'}, state.selected.map((t, i) => targetCard({...t, chance: amount(state.roundBet) / t.price * c.rtp}, i, true))),
        h('form', {class: 'ub-filters', onSubmit: event => { event.preventDefault(); model.searchItems(); }}, [
          field('Название скина', 'searchText', {placeholder: 'Например, MP5'}),
          field('Цена от, ₽', 'minPrice', {inputmode: 'decimal', placeholder: '10 000'}),
          field('Цена до, ₽', 'maxPrice', {inputmode: 'decimal'}),
          h('button', {type: 'submit', class: 'ub-button', disabled: state.searching}, state.searching ? 'Поиск…' : 'Найти')
        ]),
        state.itemError ? h('p', {role: 'alert', class: 'ub-error'}, state.itemError) : null,
        h('p', {class: 'ub-muted'}, `Найдено: ${state.total}. Показаны первые ${state.items.length}. Выбрано: ${state.selected.length}/3. Один скин можно выбрать на несколько раундов.`),
        h('div', {class: 'ub-catalog'}, state.items.map(item => h('button', {type: 'button', class: 'ub-item', key: item.id,
          disabled: model.formLocked() || state.selected.length >= 3,
          onClick: () => { if (!model.formLocked() && state.selected.length < 3) state.selected.push({...item}); }
        }, [itemImage(item), h('span', null, item.name), h('strong', null, money(item.price))]))),
        h('p', {class: 'ub-muted'}, 'Цена цели должна быть выше ставки за раунд, шанс — от 1% до 95%. Цены и шансы окончательно фиксируются сервером при создании.'),
        button('Создать батл', paidAction(model.prepareCreate), model.formLocked() || state.selected.length !== 3, true)
      ]);
    }
    function lobby() {
      const state = s.value;
      return h('div', {class: 'ub-lobby'}, [h('section', {class: 'ub-panel'}, [
        h('div', {class: 'ub-toolbar'}, [h('h2', null, 'Апгрейд-батлы'),
          button(state.history ? 'Показать ожидающие' : 'История батлов', () => { state.history = !state.history; model.load(); }, state.loading),
          button('Обновить', () => model.load(), state.loading)]),
        !state.battles.length && state.loaded && !state.error ? h('p', {class: 'ub-muted'}, state.history ? 'Завершённых батлов пока нет.' : 'Пока нет ожидающих батлов. Создайте первый.') : null,
        ...state.battles.map(b => h('article', {class: 'ub-room-row', key: b.uid}, [
          h('div', null, [h('strong', null, b.players[0]?.name || 'Игрок'), h('p', {class: 'ub-muted'}, `${statusText(b.status)} · 3 раунда · RTP ${percent(b.rtp)}`)]),
          h('div', {class: 'ub-thumbnails'}, b.targets.map(t => itemImage(t))),
          h('strong', null, money(b.entryPrice)), h('a', {class: 'ub-button ub-primary', href: roomUrl(b.uid)}, b.status === 'waiting' ? 'Открыть батл' : 'Результаты')
        ]))
      ]), creation()]);
    }
    function playerPanel(battle, slot) {
      const player = battle.players.find(p => p.slot === slot), shown = s.value.visibleRounds;
      const results = battle.rounds.filter(r => r.slot === slot && r.roundIndex < shown);
      const score = results.reduce((sum, r) => sum + Math.round(r.value * 100), 0) / 100;
      return h('section', {class: 'ub-player ub-panel'}, [
        player?.avatar && imageUrl(player.avatar) ? h('img', {class: 'ub-avatar', src: imageUrl(player.avatar), alt: ''}) : h('span', {class: 'ub-avatar', 'aria-hidden': 'true'}, '♙'),
        h('h2', null, player?.name || 'Место для соперника'),
        h('p', {class: 'ub-score'}, money(score)),
        h('ol', {class: 'ub-results'}, battle.targets.map((target, index) => {
          const result = results.find(r => r.roundIndex === index);
          return h('li', {key: index, class: result?.won ? 'ub-result ub-won' : 'ub-result'}, [h('span', null, `Раунд ${index + 1}`),
            h('strong', null, result ? (result.won ? money(result.value) : 'Неудача') : 'Ожидание'),
            h('small', {class: 'ub-muted'}, target.name)]);
        })),
        battle.status === 'finished' && shown === 3 && player ? h('p', null, `Выплата на баланс: ${money(player.payout)}`) : null
      ]);
    }
    function detail() {
      const battle = s.value.battle, shown = s.value.visibleRounds;
      const targetIndex = battle.status === 'finished' ? Math.min(shown, 2) : 0;
      return h('div', null, [h('div', {class: 'ub-toolbar'}, [
        h('a', {class: 'ub-button', href: lobbyUrl}, '← К списку'), h('h1', null, 'Батл на апгрейдах'),
        h('span', {role: 'status'}, statusText(battle.status))]),
        h('p', {class: 'ub-muted'}, `Взнос: ${money(battle.entryPrice)} · RTP ${percent(battle.rtp)} · одинаковые цели для обоих`),
        h('div', {class: 'ub-duel'}, [playerPanel(battle, 0), h('section', {class: 'ub-current'}, [
          h('h2', null, shown < 3 ? `Раунд ${shown + 1} из 3` : 'Цели батла'), targetCard(battle.targets[targetIndex], targetIndex),
          battle.status === 'waiting' ? h('p', {class: 'ub-muted'}, `Ожидание до ${new Date(battle.expiresAt).toLocaleString('ru-RU')}. Если соперник не найдётся, взнос вернётся автоматически.`) : null,
          battle.status === 'waiting' && !battle.viewerIsPlayer ? button(`Войти за ${money(battle.entryPrice)}`, paidAction(model.prepareJoin), s.value.busy, true) : null,
          battle.status === 'waiting' && battle.viewerIsCreator ? button('Отменить и вернуть взнос', model.prepareCancel, s.value.busy) : null
        ]), playerPanel(battle, 1)]),
        battle.status === 'finished' && shown === 3 ? h('section', {class: 'ub-panel ub-outcome', role: 'status'}, [
          h('h2', null, battle.pot === 0 ? 'Нет успешных апгрейдов' : battle.winnerUserIds.length > 1 ? 'Ничья — приз разделён' : `Победитель: ${battle.players.find(p => p.userId === battle.winnerUserIds[0])?.name || '—'}`),
          h('p', null, `Общий приз: ${money(battle.pot)}. Выплаты уже сохранены сервером.`)
        ]) : null,
        battle.status === 'cancelled' ? h('p', {class: 'ub-panel'}, `${battle.cancelReason || 'Батл отменён'}. Взнос возвращён создателю.`) : null,
        h('div', {class: 'ub-targets'}, battle.targets.map((t, i) => targetCard(t, i))),
        h('details', {class: 'ub-panel ub-proof'}, [h('summary', null, 'Проверка честности и ссылка на батл'),
          h('p', null, ['Батл: ', h('a', {href: roomUrl(battle.uid)}, battle.uid)]),
          h('p', null, ['SHA-256 серверного сида: ', h('code', null, battle.serverHash)]),
          h('p', null, ['Серверный сид: ', h('code', null, battle.serverSeed || 'Скрыт до завершения')]),
          ...battle.players.map(p => h('p', {key: p.slot}, [`Клиентский сид ${p.name}: `, h('code', null, p.clientSeed)])),
          h('p', {class: 'ub-muted'}, 'Расчёт: HMAC-SHA256, ключ — серверный сид, сообщение — JSON-массив ["upgrade-battle-v1", uid, [сид игрока 1, сид игрока 2], индекс раунда, слот]. Первые 13 hex-символов / 2^52. Индекс раунда и слот начинаются с 0. Победа при roll < chance.'),
          h('pre', null, JSON.stringify(battle.rounds, null, 2))
        ])
      ]);
    }
    function confirmation() {
      const c = s.value.confirmation;
      if (!c) return null;
      return h('section', {class: 'ub-panel ub-confirm', role: 'region', 'aria-label': 'Подтверждение действия', tabindex: -1,
        onVnodeMounted: vnode => vnode.el?.focus?.()}, [
        h('h2', null, c.kind === 'cancel' ? 'Вернуть взнос?' : 'Подтвердите участие'),
        h('p', null, c.kind === 'cancel' ? `Будет возвращено ${money(c.price)}, если батл ещё ожидает соперника.` : `С баланса будет ${c.kind === 'create' ? 'зарезервировано' : 'списано'} ${money(c.price)} за три раунда.`),
        c.targets ? h('div', {class: 'ub-targets'}, c.targets.map((t, i) => targetCard(t, i))) : null,
        c.kind !== 'cancel' ? h('p', {class: 'ub-muted'}, 'Победитель получает суммарную стоимость успешных апгрейдов обоих игроков. При ничьей приз делится. Если оба проиграли все раунды — выплаты нет. Взносы не прибавляются к призу.') : null,
        c.attempted ? h('p', {class: 'ub-error'}, 'Запрос мог быть принят. «Повторить тот же запрос» сохраняет его идентификатор. Перед новой заявкой проверьте список батлов: новая заявка может списать ещё один взнос.') : null,
        h('div', {class: 'ub-toolbar'}, [button(s.value.busy ? 'Подождите…' : c.attempted ? 'Повторить тот же запрос' : 'Подтвердить', paidAction(model.confirm), s.value.busy, true),
          button(c.attempted ? 'Я проверил список — закрыть заявку' : 'Отмена', model.newForm, s.value.busy),
          c.attempted ? h('a', {class: 'ub-button', href: lobbyUrl, target: '_blank', rel: 'noopener'}, 'Проверить список в новой вкладке') : null])
      ]);
    }
    return () => h('main', {class: 'ub', 'aria-busy': s.value.loading || s.value.busy}, [
      s.value.error ? h('div', {class: 'ub-panel ub-error', role: 'alert'}, [h('p', null, s.value.error),
        button('Повторить загрузку', () => model.load(), s.value.loading || s.value.busy),
        !auth.isAuthenticated ? button('Войти в аккаунт', () => auth.openAuthModal?.()) : null]) : null,
      s.value.notice ? h('p', {role: 'status'}, s.value.notice) : null,
      s.value.loading ? h('p', {role: 'status'}, 'Загрузка батлов…') : null,
      confirmation(), s.value.battle ? detail() : lobby()
    ]);
  }
});

export function withBattleModes(CaseLobby) {
  return defineComponent({name: 'UpgradeBattleModes', setup() {
    onMounted(ensureStyles);
    const upgrade = new URLSearchParams(window.location.search).get('mode') === 'upgrade';
    return () => h('div', {class: 'ub-modes'}, [h('nav', {class: 'ub-mode-nav', 'aria-label': 'Режим батлов'}, [
      h('a', {href: '/crate-pvp', class: !upgrade ? 'is-active' : '', 'aria-current': !upgrade ? 'page' : undefined}, 'На кейсах'),
      h('a', {href: lobbyUrl, class: upgrade ? 'is-active' : '', 'aria-current': upgrade ? 'page' : undefined}, 'На апгрейдах')
    ]), h(upgrade ? UpgradeBattlePage : CaseLobby)]);
  }});
}
