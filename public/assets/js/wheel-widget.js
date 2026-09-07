/**
 * Мини-колесо бонусов: свёрнутая кнопка с числом попыток справа сверху,
 * по клику — само колесо.
 *
 * НАМЕРЕННО БЕЗ VUE. Собранные чанки импортируют vendor по коротким алиасам
 * (`a as defineComponent`), а они меняются при каждой пересборке фронта. Этот
 * модуль работает с голым DOM и своим fetch, поэтому переживает пересборку и
 * не тянет за собой внутренности бандла. Стили инжектит сам — отдельный CSS
 * подключать не нужно.
 *
 * Авторизация как у остального фронта: localStorage['token'] в заголовке
 * Authorization: Bearer.
 */

const API = '/api/v1/wheel';
const SECTORS = 24;
const STEP = 360 / SECTORS;

const token = () => { try { return localStorage.getItem('token'); } catch { return null; } };
const money = v => Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(API + path, { ...options, headers });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== 'success') {
    throw Object.assign(new Error(body?.message || 'Колесо недоступно'), { code: body?.code });
  }
  return body.data;
}

const STYLE = `
.bz-wheel{position:fixed;top:88px;right:24px;z-index:900;font:500 13px/1.35 inherit;color:#fff}
.bz-wheel *{box-sizing:border-box}
.bz-wheel__btn{display:flex;align-items:center;gap:10px;padding:10px 14px 10px 10px;border:1px solid rgba(255,255,255,.10);
  border-radius:14px;background:rgba(24,20,18,.92);backdrop-filter:blur(8px);cursor:pointer;transition:transform .15s,border-color .15s;
  box-shadow:0 8px 28px rgba(0,0,0,.45)}
.bz-wheel__btn:hover{transform:translateY(-1px);border-color:rgba(243,106,33,.55)}
.bz-wheel__btn:disabled{cursor:default;opacity:.75}
.bz-wheel__mark{position:relative;width:34px;height:34px;flex:0 0 34px}
.bz-wheel__mark svg{width:100%;height:100%;display:block}
.bz-wheel__spinning .bz-wheel__mark svg{animation:bz-spin 1.1s linear infinite}
@keyframes bz-spin{to{transform:rotate(360deg)}}
.bz-wheel__label{display:flex;flex-direction:column;align-items:flex-start;line-height:1.2;white-space:nowrap}
.bz-wheel__title{font-weight:700;letter-spacing:.01em}
.bz-wheel__hint{font-size:11px;opacity:.6}
.bz-wheel__badge{position:absolute;top:-6px;right:-6px;min-width:19px;height:19px;padding:0 5px;border-radius:10px;
  background:#f36a21;color:#150d08;font:800 11px/19px inherit;text-align:center;box-shadow:0 0 0 2px rgba(24,20,18,.92)}
.bz-wheel__badge--pulse{animation:bz-pulse 1.8s ease-in-out infinite}
@keyframes bz-pulse{0%,100%{box-shadow:0 0 0 2px rgba(24,20,18,.92),0 0 0 0 rgba(243,106,33,.55)}
  50%{box-shadow:0 0 0 2px rgba(24,20,18,.92),0 0 0 7px rgba(243,106,33,0)}}

.bz-wheel__sheet{position:fixed;inset:0;z-index:950;display:flex;align-items:center;justify-content:center;
  background:rgba(6,4,3,.72);backdrop-filter:blur(3px);padding:20px}
.bz-wheel__card{width:min(420px,100%);max-height:calc(100vh - 40px);overflow:auto;border:1px solid rgba(255,255,255,.10);
  border-radius:20px;background:#151110;padding:22px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.6)}
.bz-wheel__h{margin:0 0 4px;font:800 19px/1.25 inherit}
.bz-wheel__sub{margin:0 0 16px;font-size:12px;opacity:.6}
.bz-wheel__stage{position:relative;width:min(320px,72vw);margin:0 auto 16px;aspect-ratio:1}
.bz-wheel__disc{width:100%;height:100%;transition:transform 4.6s cubic-bezier(.16,.84,.28,1)}
.bz-wheel__pin{position:absolute;top:-6px;left:50%;transform:translateX(-50%);width:0;height:0;
  border-left:11px solid transparent;border-right:11px solid transparent;border-top:20px solid #f36a21;
  filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}
.bz-wheel__go{width:100%;padding:13px;border:0;border-radius:12px;background:#f36a21;color:#150d08;
  font:800 14px inherit;cursor:pointer;transition:filter .15s}
.bz-wheel__go:hover:not(:disabled){filter:brightness(1.08)}
.bz-wheel__go:disabled{opacity:.45;cursor:default}
.bz-wheel__close{margin-top:10px;width:100%;padding:10px;border:0;border-radius:10px;background:transparent;
  color:rgba(255,255,255,.55);font:600 12px inherit;cursor:pointer}
.bz-wheel__prize{margin:0 0 14px;padding:12px;border-radius:12px;border:1px solid rgba(243,106,33,.35);
  background:rgba(243,106,33,.10);font-size:13px;min-height:44px;display:flex;align-items:center;justify-content:center}
.bz-wheel__meta{margin-top:12px;font-size:11px;opacity:.5;line-height:1.5}
@media (max-width:900px){.bz-wheel{top:auto;bottom:88px;right:16px}.bz-wheel__hint{display:none}}
@media (prefers-reduced-motion:reduce){
  .bz-wheel__disc{transition-duration:.35s}
  .bz-wheel__badge--pulse,.bz-wheel__spinning .bz-wheel__mark svg{animation:none}
}`;

function styles() {
  if (document.getElementById('bz-wheel-style')) return;
  const el = document.createElement('style');
  el.id = 'bz-wheel-style';
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/** Круглая метка колеса для свёрнутой кнопки. */
function markSvg() {
  const slices = ['#f36a21', '#f2c94c', '#6fcf97', '#56ccf2', '#bb6bd9', '#eb5757']
    .map((c, i) => `<path d="${wedge(50, 50, 46, i * 60, (i + 1) * 60)}" fill="${c}"/>`).join('');
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${slices}
    <circle cx="50" cy="50" r="16" fill="#151110"/><circle cx="50" cy="50" r="46" fill="none"
    stroke="rgba(255,255,255,.18)" stroke-width="3"/></svg>`;
}

function wedge(cx, cy, r, from, to) {
  const p = a => {
    const rad = (a - 90) * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x1, y1] = p(from), [x2, y2] = p(to);
  return `M${cx} ${cy} L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
}

/** Полное колесо из секторов, полученных от сервера. */
function discSvg(sectors) {
  const parts = sectors.map((s, i) => {
    const from = i * STEP, to = from + STEP, mid = from + STEP / 2;
    const rad = (mid - 90) * Math.PI / 180;
    const tx = 50 + 33 * Math.cos(rad), ty = 50 + 33 * Math.sin(rad);
    const label = String(s.label || '').replace(/[<>&]/g, '');
    return `<path d="${wedge(50, 50, 48, from, to)}" fill="${s.color || '#f36a21'}" stroke="rgba(0,0,0,.35)" stroke-width=".5"/>
      <text x="${tx.toFixed(2)}" y="${ty.toFixed(2)}" fill="${s.ink || '#150d08'}" font-size="5.4" font-weight="800"
        text-anchor="middle" dominant-baseline="middle"
        transform="rotate(${(mid + 90).toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)})">${label}</text>`;
  }).join('');
  return `<svg class="bz-wheel__disc" viewBox="0 0 100 100" aria-hidden="true">${parts}
    <circle cx="50" cy="50" r="13" fill="#151110" stroke="rgba(255,255,255,.2)" stroke-width="1.5"/></svg>`;
}

function prizeText(prize) {
  if (!prize) return 'Крутите колесо';
  if (prize.kind === 'balance') return `Выигрыш: ${money(prize.amount)} ₽ — уже на балансе`;
  if (prize.kind === 'discount') {
    return `Скидка ${prize.percent}% на кейс до ${money(prize.maxCasePrice)} ₽. Применится сама при открытии.`;
  }
  if (prize.kind === 'spin') return 'Ещё одна попытка!';
  return 'Приз получен';
}

export const wheelState = () => api('');

/**
 * Модалка колеса сама по себе — её открывает и угловая кнопка, и раздел в
 * профиле. onChange зовётся после прокрута, чтобы вызывающий обновил свои
 * счётчики.
 */
export function openWheel(state, onChange = () => {}) {
  styles();
  const sheet = document.createElement('div');
  sheet.className = 'bz-wheel__sheet';
  sheet.innerHTML = `<div class="bz-wheel__card" role="dialog" aria-label="Колесо бонусов">
    <h2 class="bz-wheel__h">Колесо бонусов</h2>
    <p class="bz-wheel__sub">Бесплатный прокрут раз в сутки и попытка за каждую
      ${money(state.depositStep || 1000)} ₽ пополнения</p>
    <div class="bz-wheel__stage"><div class="bz-wheel__pin"></div>${discSvg(state.sectors || [])}</div>
    <p class="bz-wheel__prize"></p>
    <button class="bz-wheel__go" type="button"></button>
    <button class="bz-wheel__close" type="button">Закрыть</button>
    <p class="bz-wheel__meta"></p></div>`;
  document.body.appendChild(sheet);

  const disc = sheet.querySelector('.bz-wheel__disc');
  const go = sheet.querySelector('.bz-wheel__go');
  const prize = sheet.querySelector('.bz-wheel__prize');
  const meta = sheet.querySelector('.bz-wheel__meta');
  let turns = 0, busy = false;

  const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && !busy) close(); };
  document.addEventListener('keydown', onKey);
  sheet.addEventListener('click', e => { if (e.target === sheet && !busy) close(); });
  sheet.querySelector('.bz-wheel__close').addEventListener('click', () => { if (!busy) close(); });

  function paintSheet() {
    const spins = state?.spins || 0;
    go.disabled = busy || spins === 0 || !token();
    go.textContent = !token() ? 'Нужен вход'
      : busy ? 'Крутим…' : spins > 0 ? `Крутить (${spins})` : 'Попыток нет';
    if (!prize.textContent) {
      prize.textContent = !token() ? 'Войдите в аккаунт — прокрут бесплатный'
        : spins > 0 ? 'Крутите колесо' : 'Попытки закончились. Завтра будет ещё.';
    }
    meta.textContent = state?.toNextDepositSpin
      ? `До следующей попытки за депозит: ${money(state.toNextDepositSpin)} ₽` : '';
  }
  paintSheet();

  go.addEventListener('click', async () => {
    if (busy) return;
    busy = true; paintSheet();
    try {
      const requestId = (crypto.randomUUID?.() || String(Date.now()) + Math.random().toString(36).slice(2))
        .replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      const result = await api('/spin', { method: 'POST', body: JSON.stringify({ requestId }) });

      // Стрелка сверху: чтобы под неё встал сектор i, диск поворачиваем на
      // минус его середину, добавив несколько полных оборотов для вида.
      turns += 5;
      disc.style.transform = `rotate(${turns * 360 - (result.sectorIndex * STEP + STEP / 2)}deg)`;

      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => {
        prize.textContent = prizeText(result.prize);
        state.spins = result.spinsLeft ?? Math.max(0, (state.spins || 1) - 1);
        busy = false; paintSheet(); onChange(state);
      }, reduced ? 400 : 4700);
    } catch (error) {
      prize.textContent = error.message || 'Не получилось. Попытка не потрачена.';
      busy = false; paintSheet(); onChange(state);
    }
  });
  return { close };
}

export function mountWheelWidget() {
  if (typeof document === 'undefined' || document.getElementById('bz-wheel')) return;
  styles();

  const root = document.createElement('div');
  root.className = 'bz-wheel';
  root.id = 'bz-wheel';
  root.innerHTML = `<button class="bz-wheel__btn" type="button">
      <span class="bz-wheel__mark">${markSvg()}<span class="bz-wheel__badge" hidden>0</span></span>
      <span class="bz-wheel__label"><span class="bz-wheel__title">Колесо</span>
      <span class="bz-wheel__hint">загрузка…</span></span></button>`;
  document.body.appendChild(root);

  const button = root.querySelector('.bz-wheel__btn');
  const badge = root.querySelector('.bz-wheel__badge');
  const hint = root.querySelector('.bz-wheel__hint');
  let state = null;

  function paint() {
    const spins = state?.spins || 0;
    badge.hidden = spins === 0;
    badge.textContent = String(spins);
    badge.classList.toggle('bz-wheel__badge--pulse', spins > 0);
    hint.textContent = !token() ? 'Войдите, чтобы крутить'
      : spins > 0 ? (spins === 1 ? '1 попытка' : `${spins} попытки`)
      : 'Завтра будет ещё';
  }

  async function refresh() {
    try { state = await api(''); } catch { state = null; hint.textContent = 'Недоступно'; return; }
    paint();
  }

  button.addEventListener('click', () => {
    if (!state) return;
    root.classList.add('bz-wheel__spinning');
    openWheel(state, next => { state = next; paint(); root.classList.remove('bz-wheel__spinning'); refresh(); });
    root.classList.remove('bz-wheel__spinning');
  });


  refresh();
  // Попытки набегают со временем и после пополнения — обновляем без перезагрузки.
  setInterval(refresh, 120000);
  window.addEventListener('focus', refresh);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountWheelWidget, { once: true });
  } else {
    mountWheelWidget();
  }
}
