# Дизайн-система

В проекте **две независимые дизайн-системы**. Не смешивай их.

| | Игровой сайт (`public/`) | Админка (`admin.titanrust.ru/public/`) |
|---|---|---|
| База | Tailwind v4 + собственные токены | Tailwind v4 + shadcn-vue (reka-ui) |
| Тема | только тёмная, зафиксирована | `light`/`dark`, класс на `<html>` из `localStorage["admin-theme"]`, дефолт `dark` |
| Палитра | тёплая коричнево-чёрная + кислотно-лаймовый акцент | нейтральный zinc в OKLCH |
| Шрифты | Onest / Druk Cyr / Inter / Roboto Condensed | Geist |
| Радиус | 8 / 12 / 16 / 999 px | `--radius: .625rem` |
| Главный CSS | [assets/css/index-BSsnhUcQ.css](../public/assets/css/index-BSsnhUcQ.css) (154 КБ) | [assets/index-CZ5Iv58h.css](../admin.titanrust.ru/public/assets/index-CZ5Iv58h.css) |

Ниже — про игровой сайт; про админку смотри блок в конце.

---

## Цвета

### Бренд-акцент — лайм `#b2ff00`

Единственный «фирменный» цвет. Всё остальное — оттенки его же.

| Токен | Значение | Где |
|---|---|---|
| `--accent-primary` / `--color-accent-primary` | `#b2ff00` | основные кнопки, активные состояния |
| `--accent-rgb` | `178,255,0` | для `rgba(var(--accent-rgb), α)` |
| `--accent-hover` | `#99e500` | hover |
| `--accent-pressed` | `#80cc00` | active |
| `--accent-bright` | `#d9ff66` | текст/иконка поверх акцента |
| `--accent-dim` / `--color-accent-muted` | `#80a500` | приглушённый |
| `--accent-on-primary` | `#181614` | текст **на** акцентной заливке |
| `--accent-knob` | `#2f4b00` | ползунки |
| `--color-accent-energy` | `#ffa600` | «энергия», отдельный акцент |

Производные (не задавай прозрачность руками — бери готовое):

```
--accent-fill-min   rgba(accent, .05)     --accent-border-min    rgba(accent, .05)
--accent-fill-faint rgba(accent, .08)     --accent-border-faint  rgba(accent, .08)
--accent-fill-soft  rgba(accent, .15)     --accent-border-soft   rgba(accent, .10)
--accent-glow       rgba(accent, .25)     --accent-focus         rgba(accent, .40)
```

### Фоны — тёплая тёмная лестница

От самого тёмного к светлому:

```
--bg-canvas       #090807   подложка страницы
--color-bg-page-bottom #070605
--bg-page-top     #100e0d   верх градиента страницы
--color-neutral-900 #13110f
--bg-feed         #1c1917   лента live-дропов
--bg-panel        #1f1c19   панели
--bg-card         #22201e   карточки  (= --bg-control)
--bg-card-inner   #2a2724   вложенные блоки
--bg-control-hover #2c2926  hover контролов
--bg-base         #181614   базовый фон приложения  (rgb 24,22,20)
--color-skeleton  #262320   скелетоны загрузки
```

Все они **тёплые** (R > G > B). Нейтральный серый в этой палитре выглядит чужеродно — не подставляй `#1e1e1e`.

### Границы и поверхности

```
--border-default   #ffffff0d   (белый 5%)
--border-strong    #ffffff1a   (белый 10%)
--surface-card-fill        color-mix(text-main 2%, transparent)
--surface-hover-fill       color-mix(text-main 9%, transparent)
--surface-hover-fill-soft  color-mix(text-main 3%, transparent)
--surface-card-hover       inset 0 0 0 1px #ffffff1f, inset 0 0 14px 2px #ffffff0f
--surface-backdrop         rgba(24,22,20,.9)
--overlay-dark             #00000080
```

Глубина в этом дизайне делается **внутренними** тенями, а не внешними:

```
--surface-inner-panel         inset 0 0 12px 2px var(--border-default)
--surface-inner-subtle        inset 0 0 12px 0 rgba(255,255,255,.02)
--surface-inner-accent        inset 0 0 12px 0 rgba(accent,.15)
--surface-inner-accent-mid    inset 0 0 12px 0 rgba(accent,.10)
--surface-inner-accent-min    inset 0 0 12px 0 rgba(accent,.05)
--surface-inner-accent-panel  inset 0 0 12px 2px rgba(accent,.05)
--surface-inner-danger-panel  inset 0 0 12px 2px rgba(255,84,58,.05)
--surface-inner-control       inset 0 0 12px 0 var(--border-default)
```

### Текст

```
--text-main   #fff        --text-soft   #96908b
--text-muted  #ffffff80   --text-faint  #ffffff4d
--text-on-accent #131213
```

### Статусы и кнопки

```
--action-primary #2b9ce5   --action-primary-hover #47adee   --action-blue #0af
--color-btn-primary #0af   --color-btn-primary-hover #3bf
--color-btn-success #87b536  --…-active #7dab2c  --…-text #ddf2b8
--color-btn-alert   #b23401  --…-active #a82a00  --…-text #ffd2c2
--color-btn-disabled #2e2d2d
--state-error   #ff543a   --color-error-primary #ff3b30
--state-success-text #9fe356  --success-primary #34c759
--state-selected-text #828a6b
--promo-gold #ffc43b   --color-promo-purple #6112a7
--switch-off #3a3733   --switch-off-hover #47433d
--tip-bg #49433f   --tip-text #c6bbb2
```

### Палитра редкостей (5 значений)

Из [assets/js/rarity-DBZTLmta.js](../public/assets/js/rarity-DBZTLmta.js) — это **источник правды** для цвета предмета:

| Редкость | Hex | |
|---|---|---|
| `GOLD` | `#ffc43b` | 🟡 covert / mythic |
| `VIOLET` | `#a33ee2` | 🟣 classified / legendary |
| `RARE` | `#65dc04` | 🟢 restricted |
| `UNUSUAL` | `#4076ff` | 🔵 mil-spec |
| `REGULAR` | `#756767` | ⚪ базовые |

Карточка предмета красится через `--rarity-rgb`, `--rarity-line`, `--rarity-fill-color`, `--rarity-gradient-color`, `--rarity-shadow` — они выставляются инлайном из этого hex. Маппинг из Steam-редкостей описан в [DATA-MODEL.md](DATA-MODEL.md#редкости-три-системы-имён).

---

## Типографика

Четыре гарнитуры, каждая со своей ролью:

| Токен | Гарнитура | Роль |
|---|---|---|
| `--font-onest` | **Onest** 400/500/600/700/900 | основной UI. Грузится с Google Fonts не-блокирующе (`media="print"` → `all` по `onload`), `display=swap` |
| `--font-druk` | **Druk Cyr Heavy Italic** | крупные заголовки/маркетинг. Локальный `.woff2` в `public/assets/woff2/` |
| `--font-inter` | Inter | вспомогательный |
| `--font-roboto` | Roboto Condensed | узкие подписи, цифры |

### Шкала размеров

```
--text-display-l 48px    --text-heading-l 24px   --text-body   16px
--text-display   40px    --text-heading-m 20px   --text-body-s 14px
                         --text-heading-s 18px   --text-caption   12px
                                                 --text-caption-s 10px
```

Устаревший параллельный набор (встречается в старых местах): `--fs-display 32`, `--fs-h1 24`, `--fs-h2 20`, `--fs-body 16`, `--fs-label 14`, `--fs-caption 12`. **В новом коде используй `--text-*`.**

Интерлиньяж: `--leading-heading-l 32` / `-m 28` / `-s 24` / `--leading-body 24` / `--leading-body-s 20` / `--leading-caption 16` / `--leading-caption-s 14`.

Насыщенность: 400 / 500 / 600 / 700 / 800 / 900 (`--font-weight-*`). Трекинг: `--tracking-tight -.025em`, `normal 0`, `wide .025em`.

---

## Форма, движение, сетка

### Радиусы
`--r-sm 8px` · `--r-md 12px` · `--r-lg 16px` · `--r-pill 999px`
(Tailwind-эквиваленты: `--radius-xs 2` / `sm 4` / `md 8` / `lg 12` / `xl 16` / `2xl 1rem` / `3xl 1.5rem`)

### Размытие
`--blur-xs 4px` · `--blur-sm 8px` · `--blur-md 12px` — для `backdrop-filter` на модалках и шапке.

### Кривые и длительности

```
--ease-ui      cubic-bezier(.2,.8,.2,1)     ← стандарт для UI-переходов
--ease-out     cubic-bezier(.16,1,.3,1)
--ease-spring  cubic-bezier(.3,1.4,.5,1)    ← пружина, для «выигрышных» акцентов
--ease-in / --ease-in-out                    базовые
```

Длительности в бандле: 0.1 / 0.12 / 0.14 / 0.15 / 0.16 / 0.18 / 0.2 / 0.3 / 0.7 s. Дефолт Tailwind — `.15s` + `cubic-bezier(.4,0,.2,1)`. Готовые анимации: `--animate-spin`, `--animate-pulse`, `--animate-input-shine` (0.7s), `--animate-tooltip-in-{top,bottom,left,right}` (0.15s).

### Отступы и брейкпоинты

Базовая единица `--spacing: .25rem` (4px) — все `p-4`, `gap-2` и т.п. считаются от неё.

Горизонтальный отступ страницы задаётся переменной `--page-padding-x`:

```
< 561px    → 16px
≥ 561px    → 24px
≥ 1267px   → 0px      (ширину держит центрированный контейнер)
```

561 и 1267 — arbitrary-варианты Tailwind (`min-[561px]:`, `min-[1267px]:`), а не стандартные брейкпоинты. Именованный есть только один: `--breakpoint-2xl: 1440px`.

### Тема

```html
<meta name="theme-color" content="#181614" />   <!-- игровой сайт -->
<meta name="theme-color" content="#0f1115" />   <!-- админка -->
```

Светлой темы на игровом сайте нет и не предполагается. `prefers-color-scheme` не используется.

---

## Правила при правках UI

1. **Никаких литеральных hex** в новом CSS. Есть токен — используй токен. Нет токена — вероятно, ты изобретаешь новый цвет, которого в системе быть не должно.
2. **Прозрачность акцента** — только через `--accent-fill-*` / `--accent-border-*` / `--accent-glow` / `--accent-focus`.
3. **Глубина — внутренними тенями** (`--surface-inner-*`), не `box-shadow` наружу.
4. **Фоны тёплые.** Не подставляй нейтральный серый.
5. **Цвет предмета** берётся из `rarity`, а не задаётся вручную.
6. **Переходы** — `--ease-ui` + 0.15–0.2s. Пружина `--ease-spring` только для выигрышных/праздничных моментов.
7. Всё в `public/assets/` — **собранный бандл**, исходников Vue в репозитории нет. Правка бандла — временная мера; см. [FRONTEND-MAP.md](FRONTEND-MAP.md).

---

## Админка (кратко)

Стандартный shadcn-vue на нейтральной zinc-палитре в OKLCH. Токены — семантические пары «цвет / foreground»: `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`. Каждый объявлен дважды — для `:root` (light) и для `.dark`.

- Шрифт: **Geist** (`--font-sans`), моно — системный стек.
- Радиус: `--radius: .625rem` (10px), от него считаются `sm/md/lg/xl`.
- Тема переключается классом на `<html>`, ключ `localStorage["admin-theme"]`, дефолт `dark` (инлайн-скрипт в `<head>` до первой отрисовки — чтобы не мигало).
- Компоненты — reka-ui: `Dialog`, `Popover`, `Command`, `Select`, `RovingFocus`, `Presence` (видно по именам чанков в `admin.titanrust.ru/public/assets/`).

Лаймовый акцент игрового сайта в админке **не используется** — не переноси его туда.
