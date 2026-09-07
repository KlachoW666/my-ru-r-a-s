/**
 * Достижения и колесо в профиле плюс всплывающие уведомления о новых
 * достижениях.
 *
 * КУДА ВСТАВЛЯЕТСЯ РАЗДЕЛ
 *
 * Якорем служит заголовок «История игр» в DOM, а не класс: классы в собранном
 * бандле генерируются заново при каждой сборке, а заголовок — часть контента и
 * переживает пересборку. Не нашли якорь — раздел просто не показывается, но
 * страница остаётся рабочей.
 *
 * Vue здесь намеренно не используется — тот же довод, что в wheel-widget.js.
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

const STYLE = `
.bz-bonus{margin:0 0 18px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(21,17,16,.7);overflow:hidden}
.bz-bonus__tabs{display:flex;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06);flex-wrap:wrap}
.bz-bonus__tab{padding:9px 16px;border:1px solid rgba(255,255,255,.10);border-radius:10px;background:transparent;
  color:rgba(255,255,255,.62);font:700 13px inherit;cursor:pointer;transition:.15s;display:flex;align-items:center;gap:7px}
.bz-bonus__tab:hover{color:#fff;border-color:rgba(243,106,33,.4)}
.bz-bonus__tab[aria-selected="true"]{background:rgba(243,106,33,.16);border-color:#f36a21;color:#fff}
.bz-bonus__pill{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#f36a21;color:#150d08;
  font:800 11px/18px inherit;text-align:center}
.bz-bonus__body{padding:16px}
.bz-bonus__wheel{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.bz-bonus__big{font:800 28px/1 inherit;color:#fff}
.bz-bonus__muted{font-size:12px;opacity:.6;line-height:1.5}
.bz-bonus__cta{margin-left:auto;padding:12px 22px;border:0;border-radius:12px;background:#f36a21;color:#150d08;
  font:800 13px inherit;cursor:pointer}
.bz-bonus__cta:disabled{opacity:.45;cursor:default}
.bz-bonus__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.bz-bonus__card{padding:12px;border:1px solid rgba(255,255,255,.07);border-radius:12px;background:rgba(255,255,255,.02)}
.bz-bonus__card--done{border-color:rgba(243,106,33,.45);background:rgba(243,106,33,.08)}
.bz-bonus__name{font:700 13px inherit;color:#fff;display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.bz-bonus__tick{color:#f36a21;font-size:14px}
.bz-bonus__reward{margin-top:3px;font-size:11px;color:#f2c94c}
.bz-bonus__bar{margin-top:8px;height:5px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
.bz-bonus__fill{height:100%;background:#f36a21;border-radius:3px;transition:width .4s}
.bz-bonus__num{margin-top:5px;font-size:11px;opacity:.5}
.bz-bonus__group{margin:14px 0 8px;font:800 11px inherit;letter-spacing:.08em;text-transform:uppercase;opacity:.45}
.bz-bonus__group:first-child{margin-top:0}

.bz-toast{position:fixed;right:24px;bottom:24px;z-index:980;display:flex;flex-direction:column;gap:10px;max-width:330px}
.bz-toast__item{display:flex;gap:12px;padding:14px;border:1px solid rgba(243,106,33,.45);border-radius:14px;
  background:#1b1410;box-shadow:0 14px 40px rgba(0,0,0,.55);animation:bz-in .35s ease both;color:#fff}
@keyframes bz-in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.bz-toast__item--out{animation:bz-out .3s ease both}
@keyframes bz-out{to{opacity:0;transform:translateX(24px)}}
.bz-toast__icon{width:38px;height:38px;flex:0 0 38px;border-radius:10px;background:rgba(243,106,33,.18);
  display:flex;align-items:center;justify-content:center;font-size:19px}
.bz-toast__kicker{font:800 10px inherit;letter-spacing:.09em;text-transform:uppercase;color:#f36a21}
.bz-toast__title{font:700 14px inherit;margin:2px 0 3px}
.bz-toast__reward{font-size:12px;color:#f2c94c}
@media (max-width:600px){.bz-toast{right:12px;left:12px;bottom:80px;max-width:none}}
@media (prefers-reduced-motion:reduce){.bz-toast__item,.bz-toast__item--out{animation:none}}`;

function styles() {
  if (document.getElementById('bz-bonus-style')) return;
  const el = document.createElement('style');
  el.id = 'bz-bonus-style';
  el.textContent = STYLE;
  document.head.appendChild(el);
}

// --- Уведомления -------------------------------------------------------------

function toast({ title, rewardText }) {
  styles();
  let box = document.querySelector('.bz-toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'bz-toast';
    document.body.appendChild(box);
  }
  const item = document.createElement('div');
  item.className = 'bz-toast__item';
  item.innerHTML = `<div class="bz-toast__icon">🏆</div><div>
    <div class="bz-toast__kicker">Достижение получено</div>
    <div class="bz-toast__title">${esc(title)}</div>
    <div class="bz-toast__reward">Награда: ${esc(rewardText)}</div></div>`;
  box.appendChild(item);
  setTimeout(() => {
    item.classList.add('bz-toast__item--out');
    setTimeout(() => { item.remove(); if (!box.children.length) box.remove(); }, 320);
  }, 6500);
}

/**
 * Опрос новых достижений. Сервер отдаёт каждое ровно один раз, поэтому
 * повторов не будет даже с несколькими вкладками.
 */
async function pollAchievements() {
  if (!token()) return;
  try {
    const list = await get('/api/v1/achievements/pending');
    list.forEach((a, i) => setTimeout(() => toast(a), i * 700));
  } catch { /* тихо: уведомления не повод ломать страницу */ }
}

// --- Раздел в профиле --------------------------------------------------------

function anchor() {
  const heading = [...document.querySelectorAll('h1,h2,h3,h4,div,span')]
    .find(el => el.children.length === 0 && el.textContent.trim() === 'История игр');
  if (!heading) return null;
  // Поднимаемся до блока-карточки, чтобы встать над ним, а не внутри заголовка.
  let node = heading;
  for (let i = 0; i < 5 && node.parentElement; i++) {
    node = node.parentElement;
    if (node.clientWidth > 400) break;
  }
  return node;
}

function achievementsHtml(data) {
  const groups = [...new Set(data.items.map(i => i.group))];
  return groups.map(g => `<div class="bz-bonus__group">${esc(g)}</div>
    <div class="bz-bonus__grid">${data.items.filter(i => i.group === g).map(i => `
      <div class="bz-bonus__card${i.unlocked ? ' bz-bonus__card--done' : ''}">
        <div class="bz-bonus__name"><span>${esc(i.title)}</span>${i.unlocked ? '<span class="bz-bonus__tick">✔</span>' : ''}</div>
        <div class="bz-bonus__reward">${esc(i.rewardText)}</div>
        <div class="bz-bonus__bar"><div class="bz-bonus__fill" style="width:${i.percent}%"></div></div>
        <div class="bz-bonus__num">${money(i.progress)} / ${money(i.threshold)}</div>
      </div>`).join('')}</div>`).join('');
}

function wheelHtml(state) {
  const spins = state?.spins || 0;
  return `<div class="bz-bonus__wheel">
    <div><div class="bz-bonus__big">${spins}</div>
      <div class="bz-bonus__muted">${spins === 1 ? 'попытка' : 'попыток'} доступно</div></div>
    <div class="bz-bonus__muted" style="max-width:320px">
      Бесплатный прокрут раз в сутки и ещё одна попытка за каждую
      ${money(state?.depositStep || 1000)} ₽ пополнения.${state?.toNextDepositSpin
        ? `<br>До следующей за депозит: ${money(state.toNextDepositSpin)} ₽.` : ''}</div>
    <button class="bz-bonus__cta" type="button" ${spins ? '' : 'disabled'}>
      ${spins ? 'Крутить колесо' : 'Попыток нет'}</button></div>`;
}

export async function mountProfile() {
  if (document.querySelector('.bz-bonus')) return;
  const target = anchor();
  if (!target) return;
  styles();

  const block = document.createElement('div');
  block.className = 'bz-bonus';
  block.innerHTML = `<div class="bz-bonus__tabs" role="tablist">
      <button class="bz-bonus__tab" role="tab" data-tab="wheel" aria-selected="true">🎡 Колесо удачи
        <span class="bz-bonus__pill" hidden></span></button>
      <button class="bz-bonus__tab" role="tab" data-tab="ach" aria-selected="false">🏆 Достижения
        <span class="bz-bonus__pill" hidden></span></button>
    </div><div class="bz-bonus__body">Загрузка…</div>`;
  target.parentElement.insertBefore(block, target);

  const body = block.querySelector('.bz-bonus__body');
  const tabs = [...block.querySelectorAll('.bz-bonus__tab')];
  let state = null, achievements = null, current = 'wheel';

  function render() {
    if (current === 'wheel') {
      body.innerHTML = state ? wheelHtml(state) : 'Колесо недоступно';
      const cta = body.querySelector('.bz-bonus__cta');
      if (cta) cta.addEventListener('click', () => openWheel(state, next => { state = next; refresh(); }));
    } else {
      body.innerHTML = achievements ? achievementsHtml(achievements) : 'Достижения недоступны';
    }
  }

  function badges() {
    const [w, a] = tabs.map(t => t.querySelector('.bz-bonus__pill'));
    const spins = state?.spins || 0;
    w.hidden = !spins; w.textContent = String(spins);
    if (achievements) { a.hidden = false; a.textContent = `${achievements.unlocked}/${achievements.total}`; }
  }

  async function refresh() {
    const [s, a] = await Promise.allSettled([wheelState(), get('/api/v1/achievements')]);
    if (s.status === 'fulfilled') state = s.value;
    if (a.status === 'fulfilled') achievements = a.value;
    badges(); render();
    pollAchievements();          // пересчёт мог открыть новые — покажем сразу
  }

  tabs.forEach(t => t.addEventListener('click', () => {
    current = t.dataset.tab;
    tabs.forEach(x => x.setAttribute('aria-selected', String(x === t)));
    render();
  }));

  await refresh();
}

/** Профиль — SPA-маршрут, поэтому следим за переходами, а не только за загрузкой. */
function watch() {
  const tick = () => {
    if (location.pathname.replace(/\/+$/, '').endsWith('/profile')) mountProfile().catch(() => {});
    else document.querySelector('.bz-bonus')?.remove();
  };
  tick();
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; setTimeout(tick, 400); } }, 500);
  // Раздел рисуется после подгрузки данных профиля — дадим ему появиться.
  new MutationObserver(() => { if (location.pathname.endsWith('/profile')) tick(); })
    .observe(document.body, { childList: true, subtree: true });
}

if (typeof window !== 'undefined') {
  const start = () => {
    watch();
    pollAchievements();
    setInterval(pollAchievements, 60000);
    window.addEventListener('focus', pollAchievements);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
