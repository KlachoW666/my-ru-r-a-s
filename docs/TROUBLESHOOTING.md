# Плейбуки: типовые баги

Отсортировано по частоте. Каждый пункт — симптом → причина → проверка → починка.

---

## 0. «Вечный спиннер, сайт не открывается»

Симптом: зелёный крутящийся индикатор на чёрном фоне, страница не рендерится **никогда и ни на одном маршруте**. Вкладка не отвечает: DevTools-консоль пустая, `document.querySelector('#app')` из консоли не возвращается.

**Причина: точка входа загружается дважды, и приложение монтируется два раза.**

```html
<!-- было в index.html -->
<script type="module" src="/assets/js/index-CyyoIbm1.js?v=2002"></script>
```

При этом 51 другой чанк импортирует ту же точку входа **без query**: `import … from "./index-CyyoIbm1.js"`. ES-модули кэшируются по полному URL, поэтому `…js?v=2002` и `…js` — это два разных модуля. Верхнеуровневый код выполняется дважды → `createApp().mount('#app')` вызывается дважды:

1. Первое монтирование строит дерево, `container._vnode` = дерево №1.
2. Второе монтирование делает `container.innerHTML = ''` — DOM дерева №1 отсоединяется.
3. Дальше Vue патчит `container._vnode` и размонтирует дерево №1, чей DOM уже оторван.
4. Внутри размонтирования вызывается `removeFragment(el, anchor)`:
   ```js
   $ = (e,t) => { let r; for(; e !== t; ) { r = nextSibling(e); remove(e); e = r } remove(t) }
   ```
   Якорь `anchor` недостижим (узлы отсоединены), `nextSibling` отдаёт `null`, условие `e !== t` истинно всегда → **бесконечный синхронный цикл**, главный поток встаёт намертво. Спиннер из `index.html` так и остаётся на экране.

**Как это выглядит при диагностике:**

```
Runtime.callFunctionOn timed out      ← evaluate не возвращается
Page.captureScreenshot timed out      ← рендерер не отдаёт кадры
Debugger.pause → стек, побайтово одинаковый в t=3s / 10s / 20s:
   #0 $   vendor-vNcy1sFx.js:0:55652   ← removeFragment
   #1 L   …:55431                      ← remove
   #2 F   …:55266                      ← unmount
   #3 N   …:55867                      ← unmountComponent
   #7 p   …:44311                      ← patch
```
Стек целиком внутри Vue, без единого кадра из кода приложения, и упирается в `app.mount()` — верный признак именно двойного монтирования, а не бага конкретного компонента.

**Починка:** убрать query-строку из `src` точки входа в `index.html`.

```html
<script type="module" crossorigin src="/assets/js/index-CyyoIbm1.js"></script>
```

**Правило на будущее:** никогда не вешать `?v=…` на entry-скрипт Vite-бандла. Кэш и так сбрасывается хэшем в имени файла (`index-CyyoIbm1.js`), а любая query-строка расщепляет модуль на две копии. Если нужно принудительно сбросить кэш — пересобирать фронт (имя файла сменится) или отдавать `Cache-Control: no-store` на `index.html`, что `server.js` уже делает ([:899](../server.js:899)).

Бэкап исходного файла: `public/index.html.bak`.

---

## 1. «Изменил в админке — на сайте не поменялось»

**Причина в 9 случаях из 10:** SELECT вернул 0 строк и молча сработал фолбэк, а не «сломался рендер».

**Проверка по цепочке, строго в этом порядке:**

```bash
# 1) есть ли данные в базе
cd D:/NewCasesRust/admin.titanrust.ru/server && node -e "const s=require('sqlite3').verbose();const db=new s.Database('database.sqlite');db.all('SELECT id,slug,name,seriesId,archived,isActive FROM cases',(e,r)=>{console.table(r);db.close()})"

# 2) что отдаёт API
curl -s http://localhost:3101/api/v1/cases/series | head -c 800

# 3) и только потом смотреть фронт
```

**Частые причины на шаге 1:**
- Кейс с `archived = 1` → не попадает в каталог (но **остаётся открываемым по прямой ссылке** — фильтра активности в `/cases/:slug` нет).
- Серия без единого кейса → выбрасывается целиком ([server.js:113](../server.js:113)).
- `seriesId` не совпал → кейс уезжает в автосерию «Популярные Кейсы» (id = 1).
- `series.status ≠ 'active'`.

**Если данные в базе есть, а API отдаёт мок** — сервер не видит базу. Проверь путь в логе старта (`Admin DB Connected: …`) и что `admin.titanrust.ru/server/node_modules/sqlite3` на месте: `server.js` требует sqlite3 **из папки админки**.

---

## 2. «Правка в бандле не видна в браузере»

Порядок проверки:

1. **Hard reload** — Ctrl+Shift+R.
2. **Service worker.** `public/sw.js` — это «самоубийца»: он чистит все кэши и разрегистрируется. Но если в браузере живёт **старый** SW с прошлой сборки, он отдаёт старые ассеты. Проверь: DevTools → Application → Service Workers → Unregister, затем Clear storage.
3. **Имя чанка изменилось.** Хэш в имени файла (`ProfilePage-cSVlEg4o.js`) — часть имени. Если правил не тот файл, а `index.html` ссылается на другой — правка не подключена. Сверься с `grep -o 'src="[^"]*"' public/index.html`.
4. Заголовки кэша сервер уже шлёт правильные (`no-store` для `index.html` и `/assets/*.js`), так что на этом шаге дело обычно не в сервере.

---

## 3. «API возвращает пустоту, ошибок нет»

```js
app.use('/api/v1', (req, res) => res.json({ status: "success", data: [] }));  // server.js:848
```

**Несуществующий путь отдаёт 200 и `data: []`, а не 404.** Опечатка в URL выглядит как «данные не пришли».

Проверка: сверь путь с [API-MAP.md](API-MAP.md) или посмотри лог сервера — он печатает `[API] GET /path` для каждого запроса. Если в логе путь есть, а в таблице роутов нет — ты попал в catch-all.

**Второй вариант:** новый роут добавлен **после** catch-all (строка 848) или после статики. Порядок middleware в Express — это порядок объявления. Все `/api/v1/*` должны быть выше строки 848.

---

## 4. «Не тот цвет у предмета / всё серое»

Три словаря редкостей, и они не совпадают — см. [DATA-MODEL.md](DATA-MODEL.md#редкости-три-системы-имён).

```
БД (Steam)      →  mapRarity()  →  фронт
COVERT          →  GOLD         →  #ffc43b
CLASSIFIED      →  VIOLET       →  #a33ee2
RESTRICTED      →  RARE         →  #65dc04
MIL_SPEC        →  UNUSUAL      →  #4076ff
INDUSTRIAL ✗    →  REGULAR      →  #756767   ← дыра
CONSUMER   ✗    →  REGULAR      →  #756767   ← дыра
```

`INDUSTRIAL` и `CONSUMER` сидит `initDatabase()`, но `mapRarity()` ([server.js:461](../server.js:461)) их не знает — они падают в серый.

> **Актуально с 2026-08-23:** каталог наполняет [services/steamCatalog.js](../services/steamCatalog.js), и он пишет в `items.rarity` сразу конечные значения (`REGULAR`/`UNUSUAL`/`RARE`/`VIOLET`/`GOLD`), а редкость берёт из `name_color` Steam, а не из цены. `mapRarity()` для таких строк работает как проброс. `normalizeLegacyRarities()` при старте переносит старые записи (651 шт. при первом запуске). Так что описанные выше дыры остались только у строк, которые ещё ни разу не обходились. Полное описание — [CATALOG.md](CATALOG.md).

Если предмет всё-таки серый — проверь, что он вообще из Steam:

```bash
cd D:/NewCasesRust/admin.titanrust.ru/server && node -e "const s=require('sqlite3').verbose();const db=new s.Database('database.sqlite');db.all('SELECT name,rarity,color,rarity_color,price_usd_cents FROM items WHERE rarity=\"REGULAR\" LIMIT 10',(e,r)=>{console.table(r);db.close()})"
```

`price_usd_cents IS NULL` — строка ещё не обойдена, её перезапишет ближайший круг.

---

## 5. «Картинка предмета не грузится»

Всё проходит через `fixImageUrl()` ([server.js:2](../server.js:2)):

- `community.steamstatic.com` → `community.cloudflare.steamstatic.com` (первый часто блокируется)
- голый хэш с `-9a81dl` → приклеивается база Steam CDN
- пусто → `/assets/battles/winner-boar.png`

Битые сид-картинки из `initDatabase()` (обрезанные хэши `-9a81dlGloryAK` и т.п.) — заведомо нерабочие URL. Их вычищает синк: `DELETE FROM items WHERE image LIKE '%-9a81dl%'`. Лечится запуском `npm run sync-skins`.

Локальные загрузки лежат в `public/uploads/{cases,series,banners,items,general}/`. Если 404 — проверь, что файл физически там: админка пишет в `../../public/uploads`, то есть в папку **игрового** сайта.

---

## 6. «Steam-логин не работает»

| Симптом | Причина | Починка |
|---|---|---|
| Steam ругается на realm | `PUBLIC_URL` не совпадает с реальным адресом сайта | выставить точно, без слэша в конце; `www` и голый домен — разные realm |
| Вернулся на `/?auth_error=steam_verification_failed` | Steam не подтвердил подпись | проверь, что `return_to` не переписывает прокси; посмотри лог `[auth] Steam OpenID: подпись не подтверждена` |
| Залогинился, но профиль пустой | `STEAM_API_KEY` не задан/отозван → `GetPlayerSummaries` вернул null | логин при этом **не падает**: ник станет `Player<последние 5 цифр>`, аватар — дефолтный |
| После редиректа сразу разлогинивает | refresh-cookie не долетела | `COOKIE_DOMAIN` должен покрывать домен; при HTTPS нужен `NODE_ENV=production` (иначе cookie без `Secure`), за nginx — `proxy_set_header X-Forwarded-Proto $scheme` |
| Всё время моковый профиль | `ALLOW_MOCK_AUTH` включён | вне `NODE_ENV=production` включается сам; поставь `NODE_ENV=production` |
| 401 на всех `/api/v1/user*` | токен не долетает | смотри `localStorage["token"]` и заголовок `Authorization` в Network |

Быстрая проверка редиректа без захода в Steam:

```bash
curl -s -o /dev/null -D - "http://localhost:3101/api/v1/auth/steam?redirect_to=https%3A%2F%2Ftitanrust.ru" | grep -i location
```

Подробности — [AUTH.md](AUTH.md).

---

## 7. «WebSocket не подключается»

Адрес вычисляется в [public/assets/js/index-CBN0naXL.js](../public/assets/js/index-CBN0naXL.js):

```js
hostname === "localhost" || "127.0.0.1" || содержит "dev"   →  s (фолбэк)
иначе                                                       →  "https://" + host
// затем: http→ws, https→wss, + "/ws"
```

То есть **на боевом домене адрес всегда собирался правильно** (`wss://titanrust.ru/ws`) — сломан был только локальный фолбэк `s`, где стоял хардкод `ws://localhost:3030`, хотя сервер слушает 3101.

**Исправлено:** фолбэк заменён на `window.location.origin`, поэтому адрес теперь верен на любом порту:

| Где | Результат |
|---|---|
| `localhost:3101` | `ws://localhost:3101/ws` |
| `titanrust.ru` | `wss://titanrust.ru/ws` |
| `www.titanrust.ru` | `wss://www.titanrust.ru/ws` |

Правка внесена прямо в бандл (исходников Vue в репозитории нет), бэкап — `index-CBN0naXL.js.bak`. **При следующей пересборке фронта она затрётся** — нужно поправить то же место в исходнике.

Если не подключается всё равно:
- за nginx нужен блок `location /ws` с `Upgrade`/`Connection` (см. [AUTH.md](AUTH.md#настройка-nginx));
- проверь руками: `node -e "const W=require('ws');const w=new W('ws://localhost:3101/ws');w.on('message',m=>console.log(m.toString()))"` — должно прийти `{"event":"connected"}`.

Протокол: клиент шлёт `{action:"auth", token:<access JWT>}`, сервер отвечает `authenticated` с профилем либо `unauthorized`. Broadcast-ов нет — live-данные фронт берёт опросом REST, поэтому «не работает WS» почти никогда не является причиной отсутствия данных на экране.

---

## 8. «В админке сохраняю — ничего не меняется»

Часть роутов админки — заглушки, возвращающие `{success:true, data:[]}` и не ходящие в базу: `promo`, `guardian`, `secret-cases`, `deposit-chain`, `giveaways`, `streamers`, `bots`, `kyc`, `accounting`, `wallet/*`, `wallet-config/*`. Список — в [API-MAP.md](API-MAP.md#заглушки-successtrue-data-в-бд-не-ходят).

**Вторая ловушка:** шесть путей объявлены в файле **дважды** (`/admin/cases/export`, `/from-catalog`, `/bulk`, `/fix-rtp`, `/guardian/banned-ips`, `/secret-cases/config`). Express берёт первое объявление. Перед правкой всегда:

```bash
grep -n "admin/cases/bulk" admin.titanrust.ru/server/server.js
```

---

## 9. «SQLITE_BUSY» / база не пишется

SQLite держат три процесса: сервер сайта (чтение), сервер админки (чтение-запись), синк скинов (запись). При ручных `UPDATE`/`DELETE` останавливай админку.

Схему создаёт и мигрирует **админка** (`initDatabase()`). Единственное исключение — `ensureAuthSchema()` в [services/auth.js](../services/auth.js), доливающая колонки для Steam-логина (`avatar`, `avatar_full`, `profile_url`, `trade_link`, `currency`, `last_login_at`) и уникальный индекс по `steam_id`. Обе миграции идемпотентны.

---

## 10. Шансы выпадения не работают

`chance` и `ticketRangeFrom/To` заполняются админкой, но `POST /cases/open` их **не читает**:

```js
const winningItem = items[Math.floor(Math.random() * items.length)];  // server.js:534
```

Равномерный выбор. RTP, волатильность, тиры из админки на выпадение не влияют вообще. Это не баг конфигурации — это отсутствующая реализация в `server.js`.

Хуже того: `chance` **отдаётся игроку** в ответе `/cases/:slug` ([server.js:576](../server.js:576)). На экране показаны одни шансы, разыгрываются другие.

Апгрейдер ([server.js:816](../server.js:816)) устроен так же: `Math.random() > 0.4` — фиксированные 60% победы независимо от множителя и ставки, а выигрышем всегда назначается `skins[0]`, самый дорогой предмет каталога.

---

## Быстрая диагностика: с чего начинать всегда

```bash
# 1. что в базе
cd D:/NewCasesRust/admin.titanrust.ru/server && node -e "const s=require('sqlite3').verbose();const db=new s.Database('database.sqlite');db.all('SELECT name FROM sqlite_master WHERE type=\"table\"',(e,r)=>{console.log(r.map(x=>x.name).join(' '));db.close()})"

# 2. живы ли серверы
curl -s -o /dev/null -w "site  %{http_code}\n" http://localhost:3101/api/v1/cases
curl -s -o /dev/null -w "admin %{http_code}\n" http://localhost:8080/api/v1/cases

# 3. лог сайта печатает каждый API-запрос как [API] GET /path — смотри туда первым делом
```
