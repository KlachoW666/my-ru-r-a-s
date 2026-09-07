/**
 * «Колесо удачи» и «Достижения» — двумя вкладками в строке «История игр»,
 * рядом с «Кейсы / Апгрейд / Батлы».
 *
 * КАК ВСТРАИВАЕТСЯ БЕЗ СВОЕГО ДИЗАЙНА
 *
 * Кнопки не стилизуются здесь вообще: className копируется у уже существующей
 * неактивной вкладки («Апгрейд»), поэтому они выглядят ровно как остальные и
 * останутся такими же, если тему поменяют. Активное состояние тоже берётся с
 * живой кнопки — с «Кейсы», когда она выбрана.
 *
 * Якорем служит текст вкладок, а не классы: классы в собранном бандле
 * генерируются заново при каждой сборке, а подписи — часть контента. Не нашли
 * строку вкладок — ничего не добавляем, страница остаётся рабочей.
 *
 * Vue не используется намеренно: собранные чанки импортируют vendor по
 * коротким алиасам, которые меняются при каждой пересборке.
 */

import { openWheel, wheelState } from './wheel-widget.js';

const token = () => { try { return localStorage.getItem('token'); } catch { return null; } };
const money = v => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function get(url) {
  const headers = { Accept: 'application/json' };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(url, { headers });
  const b = await r.json().catch(() => null);
  if (!r.ok || b?.status !== 'success') throw new Error(b?.message || 'Недоступно');
  return b.data;
}

async function claimReward(code) {
  const headers = { Accept: 'application/json' };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(`/api/v1/achievements/${encodeURIComponent(code)}/claim`, { method: 'POST', headers });
  const b = await r.json().catch(() => null);
  if (!r.ok || b?.status !== 'success') throw new Error(b?.message || 'Не удалось получить награду');
  return b.data;
}

/*
 * Собственных стилей — минимум, и только для содержимого панели: сетка,
 * полоска прогресса и уведомление. Цвета берутся у страницы через
 * currentColor и полупрозрачный белый, чтобы не спорить с темой.
 */
const STYLE = `
.bz-panel{padding:4px 0 8px}
.bz-sections{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 16px}
.bz-sec{position:relative;display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:10px;
  border:1px solid rgba(255,255,255,.09);background:transparent;color:rgba(255,255,255,.6);
  font-weight:700;font-size:13px;cursor:pointer;transition:.15s}
.bz-sec:hover{color:#fff;border-color:rgba(243,106,33,.4)}
.bz-sec--on{background:rgba(243,106,33,.14);border-color:#f36a21;color:#fff}
.bz-sec__n{font-size:11px;font-weight:800;opacity:.65;font-variant-numeric:tabular-nums}
.bz-sec--on .bz-sec__n{opacity:.9}
.bz-sec__dot{width:6px;height:6px;border-radius:50%;background:#f36a21;box-shadow:0 0 0 3px rgba(243,106,33,.2)}
.bz-panel__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.bz-panel__card{position:relative;padding:13px;border:1px solid rgba(255,255,255,.07);border-radius:12px;
  background:rgba(255,255,255,.02)}
.bz-panel__card--done{border-color:rgba(243,106,33,.4);background:rgba(243,106,33,.06)}
.bz-panel__tick{position:absolute;top:11px;right:12px;color:#f36a21;font-size:13px;font-weight:800}
.bz-panel__name{font-weight:700;font-size:13px;padding-right:18px}
.bz-panel__reward{margin-top:3px;font-size:11px;color:#f2c94c}
.bz-panel__bar{margin-top:9px;height:4px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden}
.bz-panel__fill{height:100%;background:#f36a21;border-radius:2px;transition:width .4s}
.bz-panel__num{margin-top:5px;font-size:11px;opacity:.45}
.bz-panel__get{margin-top:9px;width:100%;padding:7px;border:0;border-radius:8px;background:#f36a21;color:#150d08;
  font-weight:800;font-size:12px;cursor:pointer}
.bz-panel__get:disabled{opacity:.5;cursor:default}
.bz-panel__done{margin-top:9px;font-size:11px;color:#6fcf97}
.bz-panel__wheel{display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:6px 0}
.bz-panel__big{font-size:30px;font-weight:800;line-height:1}
.bz-panel__muted{font-size:12px;opacity:.6;line-height:1.55}
.bz-panel__spacer{flex:1}

.bz-toast{position:fixed;right:24px;bottom:24px;z-index:980;display:flex;flex-direction:column;gap:10px;max-width:340px}
.bz-toast__item{position:relative;display:flex;gap:12px;padding:15px 34px 15px 15px;border:1px solid rgba(243,106,33,.4);
  border-radius:14px;background:#1b1410;box-shadow:0 14px 40px rgba(0,0,0,.55);color:#fff;animation:bz-in .3s ease both}
@keyframes bz-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.bz-toast__item--out{animation:bz-out .28s ease both}
@keyframes bz-out{to{opacity:0;transform:translateX(20px)}}
.bz-toast__body{flex:1;min-width:0}
.bz-toast__kicker{font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#f36a21}
.bz-toast__title{font-size:14px;font-weight:700;margin:3px 0 3px}
.bz-toast__reward{font-size:12px;color:#f2c94c}
.bz-toast__get{margin-top:10px;padding:8px 18px;border:0;border-radius:9px;background:#f36a21;color:#150d08;
  font-weight:800;font-size:12px;cursor:pointer}
.bz-toast__get:disabled{opacity:.5;cursor:default}
.bz-toast__x{position:absolute;top:9px;right:10px;width:22px;height:22px;border:0;border-radius:6px;
  background:transparent;color:rgba(255,255,255,.45);font-size:14px;line-height:1;cursor:pointer}
.bz-toast__x:hover{background:rgba(255,255,255,.08);color:#fff}
@media (max-width:600px){.bz-toast{right:12px;left:12px;bottom:80px;max-width:none}}
@media (prefers-reduced-motion:reduce){.bz-toast__item,.bz-toast__item--out{animation:none}}`;

function styles() {
  if (document.getElementById('bz-panel-style')) return;
  const el = document.createElement('style');
  el.id = 'bz-panel-style';
  el.textContent = STYLE;
  document.head.appendChild(el);
}

// --- Уведомления -------------------------------------------------------------

/**
 * Уведомление о достижении: «Получить» и крестик.
 *
 * Крестик НЕ отменяет награду — достижение остаётся в профиле со своей
 * кнопкой. Поэтому уведомление само по таймеру не гаснет: иначе награду
 * легко проморгать, а она уже начислена не будет.
 */
function toast({ code, title, rewardText }) {
  styles();
  let box = document.querySelector('.bz-toast');
  if (!box) { box = document.createElement('div'); box.className = 'bz-toast'; document.body.appendChild(box); }
  const item = document.createElement('div');
  item.className = 'bz-toast__item';
  item.innerHTML = `<div class="bz-toast__body">
      <div class="bz-toast__kicker">Достижение получено</div>
      <div class="bz-toast__title">${esc(title)}</div>
      <div class="bz-toast__reward">Награда: ${esc(rewardText)}</div>
      <button class="bz-toast__get" type="button">Получить</button>
    </div>
    <button class="bz-toast__x" type="button" aria-label="Закрыть">✕</button>`;
  box.appendChild(item);

  const close = () => {
    item.classList.add('bz-toast__item--out');
    setTimeout(() => { item.remove(); if (box && !box.children.length) box.remove(); }, 300);
  };
  item.querySelector('.bz-toast__x').addEventListener('click', close);

  const get = item.querySelector('.bz-toast__get');
  get.addEventListener('click', async () => {
    get.disabled = true; get.textContent = 'Получаем…';
    try {
      await claimReward(code);
      close();
      // Награда лежит на колесе — открываем его сразу: за ним игрок и шёл.
      const state = await wheelState().catch(() => null);
      if (state) openWheel(state);
      document.dispatchEvent(new CustomEvent('bz:refresh'));
    } catch (error) {
      get.disabled = false; get.textContent = 'Получить';
      item.querySelector('.bz-toast__reward').textContent = error.message || 'Не удалось получить';
    }
  });
}

async function pollAchievements() {
  if (!token()) return;
  try {
    const list = await get('/api/v1/achievements/pending');
    list.forEach((a, i) => setTimeout(() => toast(a), i * 600));
  } catch { /* тихо: уведомления не повод ломать страницу */ }
}

// --- Поиск строки вкладок ----------------------------------------------------

const LABELS = ['Кейсы', 'Апгрейд', 'Батлы'];

/**
 * Находит строку вкладок истории.
 *
 * Искать первое совпадение по тексту нельзя: «Кейсы» и «Батлы» есть ещё и в
 * шапке сайта, и поиск уводило туда. Поэтому собираем ВСЕХ кандидатов на
 * каждую подпись и ищем контейнер, в котором лежат все три сразу.
 */
function tabStrip() {
  const all = [...document.querySelectorAll('button, a, div[role="tab"]')];
  const candidates = LABELS.map(text => all.filter(el => el.textContent.trim() === text));
  if (candidates.some(list => !list.length)) return null;

  for (const first of candidates[0]) {
    const strip = first.parentElement;
    if (!strip) continue;
    const rest = candidates.slice(1).map(list => list.find(el => el.parentElement === strip));
    if (rest.every(Boolean)) return { strip, buttons: [first, ...rest] };
  }
  return null;
}

/** Класс неактивной вкладки — с него копируем вид своих кнопок. */
function tabClass(buttons) {
  const byLength = [...buttons].sort((a, b) => a.className.length - b.className.length);
  return byLength[0]?.className || '';
}

// --- Содержимое панелей ------------------------------------------------------

const cardHtml = i => `
  <div class="bz-panel__card${i.unlocked ? ' bz-panel__card--done' : ''}">
    ${i.unlocked ? '<span class="bz-panel__tick">✓</span>' : ''}
    <div class="bz-panel__name">${esc(i.title)}</div>
    <div class="bz-panel__reward">${esc(i.rewardText)}</div>
    <div class="bz-panel__bar"><div class="bz-panel__fill" style="width:${i.percent}%"></div></div>
    <div class="bz-panel__num">${money(i.progress)} / ${money(i.threshold)}</div>
    ${i.claimable ? `<button class="bz-panel__get" type="button" data-claim="${esc(i.code)}">Получить</button>`
      : i.claimed ? `<div class="bz-panel__done">Награда получена</div>` : ''}
  </div>`;

/**
 * Достижения разбиты на разделы. Показывается один раздел за раз — иначе
 * тридцать карточек одной простынёй, и найти в них что-то нельзя.
 * Раздел с невзятой наградой помечается точкой, чтобы её было видно, не
 * перебирая вкладки.
 */
function achievementsHtml(data, section) {
  const groups = [...new Set(data.items.map(i => i.group))];
  const shown = groups.includes(section) ? section : groups[0];
  const inGroup = g => data.items.filter(i => i.group === g);

  const nav = groups.map(g => {
    const list = inGroup(g);
    const done = list.filter(i => i.unlocked).length;
    const wait = list.some(i => i.claimable);
    return `<button type="button" class="bz-sec${g === shown ? ' bz-sec--on' : ''}" data-section="${esc(g)}">
      ${esc(g)}<span class="bz-sec__n">${done}/${list.length}</span>
      ${wait ? '<span class="bz-sec__dot" title="Есть неполученная награда"></span>' : ''}</button>`;
  }).join('');

  return `<div class="bz-panel">
    <div class="bz-sections">${nav}</div>
    <div class="bz-panel__grid">${inGroup(shown).map(cardHtml).join('')}</div>
  </div>`;
}

function wheelHtml(state) {
  const spins = state?.spins || 0;
  return `<div class="bz-panel"><div class="bz-panel__wheel">
    <div><div class="bz-panel__big">${spins}</div>
      <div class="bz-panel__muted">${spins === 1 ? 'попытка' : 'попыток'} доступно</div></div>
    <div class="bz-panel__muted" style="max-width:340px">
      Бесплатный прокрут раз в сутки и ещё одна попытка за каждую
      ${money(state?.depositStep || 1000)} ₽ пополнения.${state?.toNextDepositSpin
        ? `<br>До следующей за депозит: ${money(state.toNextDepositSpin)} ₽.` : ''}</div>
    <div class="bz-panel__spacer"></div>
    <button class="bz-panel__go" type="button" ${spins ? '' : 'disabled'}></button>
  </div></div>`;
}

// --- Встраивание -------------------------------------------------------------

export async function mountProfile() {
  if (document.querySelector('[data-bz-tab]')) return;
  const found = tabStrip();
  if (!found) return;
  styles();

  const { strip, buttons } = found;
  const idleClass = tabClass(buttons);
  const activeClass = buttons.find(b => b.className !== idleClass)?.className || idleClass;

  // Кнопки встают ПЕРЕД «Кейсы» — там, где для них оставлено место.
  const mine = [
    { key: 'wheel', label: 'Колесо удачи' },
    { key: 'ach', label: 'Достижения' }
  ].map(({ key, label }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = idleClass;
    b.dataset.bzTab = key;
    b.textContent = label;
    // Подписи длиннее соседних — без этого «Колесо удачи» ломается на две строки.
    b.style.whiteSpace = 'nowrap';
    strip.insertBefore(b, buttons[0]);
    return b;
  });

  let panel = null, state = null, data = null, active = null, section = null;

  // Всё, что идёт после строки вкладок внутри карточки, — это таблица истории.
  const host = strip.closest('div');
  const hideable = () => {
    const card = host?.parentElement;
    if (!card) return [];
    return [...card.children].filter(el => el !== host && !el.contains(strip) && el !== panel);
  };

  function showPanel(html) {
    if (!panel) {
      panel = document.createElement('div');
      panel.dataset.bzPanel = '1';
      host.parentElement.insertBefore(panel, host.nextSibling);
    }
    panel.innerHTML = html;
    hideable().forEach(el => { el.dataset.bzHidden = '1'; el.style.display = 'none'; });
  }

  function hidePanel() {
    panel?.remove(); panel = null;
    document.querySelectorAll('[data-bz-hidden]').forEach(el => {
      el.style.display = ''; delete el.dataset.bzHidden;
    });
  }

  function paintTabs() {
    mine.forEach(b => { b.className = b.dataset.bzTab === active ? activeClass : idleClass; });
    if (active) buttons.forEach(b => { if (b.className === activeClass) b.className = idleClass; });
  }

  function render() {
    if (active === 'wheel') {
      showPanel(state ? wheelHtml(state) : '<div class="bz-panel bz-panel__muted">Колесо недоступно</div>');
      const go = panel.querySelector('.bz-panel__go');
      if (go) {
        go.className = activeClass;
        go.textContent = (state?.spins || 0) ? 'Крутить колесо' : 'Попыток нет';
        go.addEventListener('click', () => openWheel(state, next => { state = next; refresh(); }));
      }
    } else if (active === 'ach') {
      showPanel(data ? achievementsHtml(data, section)
        : '<div class="bz-panel bz-panel__muted">Достижения недоступны</div>');
      panel.querySelectorAll('[data-section]').forEach(btn => btn.addEventListener('click', () => {
        section = btn.dataset.section;
        render();
      }));
      panel.querySelectorAll('[data-claim]').forEach(btn => btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = 'Получаем…';
        try {
          await claimReward(btn.dataset.claim);
          await refresh();
        } catch (error) {
          btn.disabled = false; btn.textContent = error.message || 'Не удалось';
        }
      }));
    }
  }

  function labels() {
    const spins = state?.spins || 0;
    mine[0].textContent = spins ? `Колесо удачи (${spins})` : 'Колесо удачи';
    mine[1].textContent = data ? `Достижения (${data.unlocked}/${data.total})` : 'Достижения';
  }

  async function refresh() {
    const [s, a] = await Promise.allSettled([wheelState(), get('/api/v1/achievements')]);
    if (s.status === 'fulfilled') state = s.value;
    if (a.status === 'fulfilled') data = a.value;
    labels();
    if (active) render();
  }

  mine.forEach(b => b.addEventListener('click', () => {
    active = b.dataset.bzTab;
    paintTabs(); render();
  }));

  // Возврат к истории игр: снимаем свою панель и подсветку.
  buttons.forEach(b => b.addEventListener('click', () => {
    active = null; hidePanel(); paintTabs();
  }));

  await refresh();
}

/** Профиль — SPA-маршрут, поэтому следим за переходами, а не только за загрузкой. */
function watch() {
  const tick = () => {
    if (location.pathname.replace(/\/+$/, '').endsWith('/profile')) mountProfile().catch(() => {});
    else document.querySelectorAll('[data-bz-tab],[data-bz-panel]').forEach(el => el.remove());
  };
  tick();
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; setTimeout(tick, 400); } }, 500);
  new MutationObserver(() => { if (location.pathname.endsWith('/profile')) tick(); })
    .observe(document.body, { childList: true, subtree: true });
}

if (typeof window !== 'undefined') {
  const start = () => {
    watch();
    pollAchievements();
    setInterval(pollAchievements, 60000);
    window.addEventListener('focus', pollAchievements);
    document.addEventListener('bz:refresh', () => mountProfile().catch(() => {}));
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
