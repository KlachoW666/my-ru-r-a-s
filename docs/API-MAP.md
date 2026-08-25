# Карта API

Два сервера, оба на префиксе `/api/v1`, но **разные процессы и разные порты**. Номера строк — по рабочей копии на 2026-08-23.

Легенда источника данных:
- 🗄 — читает SQLite админки
- 🎭 — статичный мок в памяти процесса
- 🔀 — читает БД, при пустом результате отдаёт мок

---

## Игровой сервер — [server.js](../server.js), порт 3101

### Кейсы и предметы

| Метод | Путь | Стр. | Источник | Заметки |
|---|---|---|---|---|
| GET | `/api/v1/cases/series` | [338](../server.js:338) | 🔀 | `getLiveSeries()`; серии без кейсов выбрасываются |
| GET | `/api/v1/cases` | [343](../server.js:343) | 🔀 | плоский список, дедуп по `slug` |
| GET | `/api/v1/cases/:slug` | [398](../server.js:398) | 🔀 | `{case, items}`; **если slug не найден — молча отдаёт первый кейс из БД** |
| GET | `/api/v1/cases/:slug/grid` | [364](../server.js:364) | 🔀 | сетка предметов |
| GET | `/api/v1/cases/:slug/best` | [369](../server.js:369) | 🔀 | лучшие дропы |
| GET | `/api/v1/cases/limited/remaining` | [356](../server.js:356) | 🎭 | |
| GET | `/api/v1/cases/secret/state` | [360](../server.js:360) | 🎭 | |
| POST | `/api/v1/cases/open`<br>`/api/v1/cases/:slug/open` | [518](../server.js:518) | 🔀 | списывает с `mockUser.balance`, выбирает предмет **равновероятно** |
| GET | `/api/v1/skins` | [331](../server.js:331) | 🔀 | весь каталог `items` |
| POST | `/api/v1/admin/sync-skins`<br>`/api/v1/skins/sync` | [316](../server.js:316) | — | запускает `syncRustSkins(count)`, ходит в Steam |

### Пользователь и конфиг

| Метод | Путь | Стр. | Источник |
|---|---|---|---|
| ALL | `/api/v1/auth/{refresh,me,steam,login/email,register/email}` | [585](../server.js:585) | 🎭 `mockUser` + `token: "mock_token_12345"` |
| ALL | `/api/v1/auth/logout` | [589](../server.js:589) | 🎭 |
| GET | `/api/v1/user`, `/user/me`, `/users/me`, `/profile` | [591](../server.js:591) | 🎭 |
| GET | `/api/v1/user/stats` | [595](../server.js:595) | 🎭 |
| GET | `/api/v1/user/ban-status` | [599](../server.js:599) | 🎭 |
| GET | `/api/v1/user/favorites` | [603](../server.js:603) | 🎭 |
| PUT | `/api/v1/user/{tradeurl,display-name,avatar}` | [608](../server.js:608) | 🎭 мутирует `mockUser` |
| GET | `/api/v1/config`, `/config/games`, `/game/config` | [615](../server.js:615) | 🎭 `mockConfig` — флаги режимов и пути к звукам |
| GET | `/api/v1/config/socials` | [619](../server.js:619) | 🎭 |

### Игровые механики

| Метод | Путь | Стр. | Источник |
|---|---|---|---|
| GET | `/api/v1/banners`, `/banner`, `/banners` | [654](../server.js:654) | 🔀 `banners WHERE active=1` |
| GET | `/api/v1/live/recent`, `/drops/recent` | [665](../server.js:665) | 🔀 |
| GET | `/api/v1/stats/global`, `/stats` | [680](../server.js:680) | 🎭 `mockStats` |
| GET | `/api/v1/deposit-chain/state` | [685](../server.js:685) | 🎭 |
| GET | `/api/v1/upgrader/items` | [702](../server.js:702) | 🔀 |
| POST | `/api/v1/upgrader/place` | [707](../server.js:707) | 🎭 |
| POST | `/api/v1/upgrader/offer/accept` | [723](../server.js:723) | 🎭 |
| GET | `/api/v1/giveaways/active-mega` | [728](../server.js:728) | 🔀 |
| GET | `/api/v1/giveaway`, `/giveaways` | [744](../server.js:744) | 🎭 |
| POST | `/api/v1/giveaways/:id/join` | [761](../server.js:761) | 🎭 |
| GET | `/api/v1/crate-pvp`, `/battles` | [766](../server.js:766) | 🔀 приватные замесы в список не попадают |
| POST | `/api/v1/battles/create` | [785](../server.js:785) | 🎭 |
| POST | `/api/v1/battles/:id/join`, `/add-bot` | [800](../server.js:800) | 🎭 |
| GET | `/api/v1/promo/active` | [649](../server.js:649) | 🎭 |
| POST | `/api/v1/promo/{redeem,validate}` | [632](../server.js:632) | 🎭 |
| GET | `/api/v1/wallet`, `/wallet/config` | [805](../server.js:805) | 🎭 |
| GET | `/api/v1/wallet/transactions` | [820](../server.js:820) | 🎭 |
| POST | `/api/v1/wallet/deposit/card` | [830](../server.js:830) | 🎭 |
| POST | `/api/v1/wallet/withdraw` | [843](../server.js:843) | 🎭 |

### Ловушка: catch-all

```js
app.use('/api/v1', (req, res) => res.json({ status: "success", data: [] }));  // :848
```

**Несуществующий эндпоинт возвращает 200 и пустой массив, а не 404.** Поэтому опечатка в пути на фронте выглядит как «данные не пришли», а не как ошибка. Если ручка «молча пустая» — сначала сверь путь с этой таблицей.

### Порядок middleware (важен!)

`server.js` строит цепочку строго в этом порядке — вставлять новое надо в правильное место, иначе не сработает:

1. `cors()`, `express.json()` — [:30](../server.js:30)
2. логгер `[API] METHOD /path` — [:34](../server.js:34)
3. **все роуты `/api/v1/*`** — [:316](../server.js:316)–[:848](../server.js:848)
4. catch-all `/api/v1` — [:848](../server.js:848)
5. статика по папкам: `/audio`, `/sounds`, `/avatars`, `/icons`, `/png`, `/svg`, `/image`, `/packs`, `/uploads`, `/assets` — [:855](../server.js:855)–[:886](../server.js:886)
6. статика корня — только для путей с расширением, `.html` исключён — [:889](../server.js:889)
7. SPA-фолбэк `app.get('*')` → `index.html` с `Cache-Control: no-store` — [:899](../server.js:899)

Новый API-роут, добавленный после шага 4, никогда не вызовется.

---

## Сервер админки — [admin.titanrust.ru/server/server.js](../admin.titanrust.ru/server/server.js), порт 8080

Все `/api/v1/admin/*` обёрнуты в `requireAdminJWT`. Он делает две вещи: проверяет токен (только при `ADMIN_REQUIRE_AUTH=1`) и **проверяет права роли** по раскладке из [adminAccess.js](../admin.titanrust.ru/server/adminAccess.js) — всегда, даже при выключенной проверке токена. Отказ по правам — 403 с полями `role`, `domain`, `required`, `granted`; отказ по токену — 401.

При `ADMIN_REQUIRE_AUTH=0` роль берётся из `ADMIN_DEV_ROLE` (по умолчанию `SUPER_ADMIN`), поэтому обычный локальный запуск ведёт себя как раньше. Роли и домены описаны в [ADMIN.md](ADMIN.md#права-доступа).

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/admin/auth/me` | профиль с настоящей ролью, `permissions` и картой `access` |
| GET | `/admin/auth/roles`, `/admin/admins/roles` | справочник ролей с их правами |
| GET | `/admin/admins` | администраторы, роль и число passkey у каждого |
| POST | `/admin/admins` | завести администратора (только `SUPER_ADMIN`) |
| PUT/PATCH | `/admin/admins/:id` | сменить логин, почту или роль |
| DELETE | `/admin/admins/:id` | удалить вместе с его passkey |
| GET | `/admin/auth/passkeys` | ключи с привязкой к администратору и его ролью |

`POST /admin/auth/register/options` принимает `username` — ключ привяжется к этому администратору и при входе получит его роль.

### Реально пишет в БД

| Ресурс | Роуты | Стр. |
|---|---|---|
| Предметы | GET/POST/PUT/DELETE `/admin/cases/items[/:id]` | [257](../admin.titanrust.ru/server/server.js:257)–[297](../admin.titanrust.ru/server/server.js:297) |
| Импорт в апгрейдер | POST `/admin/cases/items/import-upgrader` | [308](../admin.titanrust.ru/server/server.js:308) |
| Каталог | GET `/admin/cases/catalog-items` | [363](../admin.titanrust.ru/server/server.js:363) |
| Кейсы | GET/POST/PUT/DELETE `/admin/cases[/:id]` | [421](../admin.titanrust.ru/server/server.js:421), [751](../admin.titanrust.ru/server/server.js:751), [797](../admin.titanrust.ru/server/server.js:797), [869](../admin.titanrust.ru/server/server.js:869) |
| Активация кейса | POST `/admin/cases/:id/{reactivate,deactivate}` | [651](../admin.titanrust.ru/server/server.js:651), [664](../admin.titanrust.ru/server/server.js:664) |
| Серии | GET/POST/PUT/DELETE `/admin/cases/series[/:id]` | [458](../admin.titanrust.ru/server/server.js:458)–[633](../admin.titanrust.ru/server/server.js:633) |
| Статус серии | POST `/admin/cases/series/:id/{activate,pause,resume,close,duplicate}` | [598](../admin.titanrust.ru/server/server.js:598)–[628](../admin.titanrust.ru/server/server.js:628) |
| Limited / Secret | PUT `/…/:id/limited`, PATCH `/…/:id/secret` | [578](../admin.titanrust.ru/server/server.js:578), [588](../admin.titanrust.ru/server/server.js:588) |
| RTP по тиру | GET/PUT `/admin/rtp/cases/:caseId/tier/:tierId` | [878](../admin.titanrust.ru/server/server.js:878), [895](../admin.titanrust.ru/server/server.js:895) |
| Баннеры | GET/POST `/admin/banners` | [981](../admin.titanrust.ru/server/server.js:981), [986](../admin.titanrust.ru/server/server.js:986) |
| Страницы | GET/POST `/admin/pages` | [994](../admin.titanrust.ru/server/server.js:994) |
| Пользователи | GET `/admin/users` | [976](../admin.titanrust.ru/server/server.js:976) |
| Выводы | GET `/admin/withdrawals` | [1011](../admin.titanrust.ru/server/server.js:1011) |
| **Загрузка файлов** | POST `/admin/media/upload?folder=<cases\|series\|banners\|items\|general>` | [1038](../admin.titanrust.ru/server/server.js:1038) |

### Заглушки (`{success:true, data:[]}`, в БД не ходят)

`promo`, `guardian/banned-ips`, `secret-cases/*`, `deposit-chain/*`, `giveaways`, `streamers`, `bots/profiles`, `kyc`, `accounting`, `wallet/*`, `wallet-config/*`, `rtp/stats`, `topdrops/config`, `drop-upgrade/config`, `config/games`, `config/socials`, `stats/online`, `cases/series/:id/{monitor,audit,supply}` — [1117](../admin.titanrust.ru/server/server.js:1117)–[1237](../admin.titanrust.ru/server/server.js:1237).

Если страница админки «сохраняет, но ничего не меняется» — она почти наверняка бьёт в одну из этих заглушек.

### Дубликаты роутов

`/admin/cases/export`, `/admin/cases/from-catalog`, `/admin/cases/bulk`, `/admin/cases/fix-rtp`, `/admin/guardian/banned-ips` и `/admin/secret-cases/config` объявлены **дважды** ([677](../admin.titanrust.ru/server/server.js:677)–[724](../admin.titanrust.ru/server/server.js:724) и [1062](../admin.titanrust.ru/server/server.js:1062)–[1160](../admin.titanrust.ru/server/server.js:1160)). Express берёт первый — правки во втором объявлении не действуют. Всегда проверяй `grep -n "путь" server.js`, прежде чем править.

### Публичные роуты админского сервера

`GET /api/v1/cases/series` [639](../admin.titanrust.ru/server/server.js:639), `GET /api/v1/cases` [926](../admin.titanrust.ru/server/server.js:926), `GET /api/v1/cases/:slug` [935](../admin.titanrust.ru/server/server.js:935) — дублируют игровой сервер на порту 8080. Игровой фронт их **не** использует; они для проверки данных вручную.

---

## Формы ответа, снятые с бандла

Три эндпоинта ждут форму, отличную от общего конверта `{status, data}`. Всё выяснено чтением кода бандла, а не угадано — каждая из этих ручек уже один раз ломала экран молча.

### `/live/recent` — лента дропов

```json
{ "status": "success", "data": { "wins": [ … ] } }
```

Фронт читает **`data.wins`** ([store-CfUBv1CE.js](../public/assets/js/store-CfUBv1CE.js)). Плоский массив в `data` даёт пустую ленту без единой ошибки в консоли.

Поля записи:

| Поле | Смысл |
|---|---|
| `sourceEventId` | id события; для `BATTLE` становится `battleId` |
| `userId`, `userName`, `avatarUrl`, `steamLevel` | игрок |
| `wonAt` | unix-секунды |
| `eventType` | `CASE` / `BATTLE` / `UPGRADER` — ключи карты `{CASE:"case", BATTLE:"cratebattle", UPGRADER:"upgrader"}` |
| `itemName`, `itemImage`, `itemValue` | предмет |
| `betAmount`, `winAmount`, `multiplier` | цифры сделки |
| `isBigWin` | подсвечивает запись меткой BIG WIN |
| `caseImage`, `caseSlug` | откуда выпало |
| `itemColor`, `itemRarity` | `itemRarity` проходит валидатор из `rarity-*.js` — допустимы только `REGULAR` / `UNUSUAL` / `RARE` / `VIOLET` / `GOLD`, иначе поле выбрасывается |

Режимы: `?mode=live` (по свежести), `?mode=top` и `?mode=bigwins` (по убыванию `itemValue`).

### `/upgrader/items` — каталог апгрейдера

```json
{ "items": [ … ], "pagination": { "page": 1, "limit": 48, "total": 5430 } }
```

`items` и `pagination` лежат на **верхнем уровне тела**, а не внутри `data` ([index-BHZ_nufV.js](../public/assets/js/index-BHZ_nufV.js)): бесконечная прокрутка считает `page * limit < total`. Фронт шлёт `page`, `limit`, `priceMin`, `priceMax`, `search`, `sort`.

Отдавать весь каталог одним куском нельзя — это 1.9 МБ на запрос при 5430 предметах.

### `/deposit-chain/state` — «Бесплатные кейсы за депозит»

```json
{ "status": "success", "data": {
    "showLadder": true, "variant": "A", "completed": false,
    "currency": "RUB", "activeTierIndex": 1,
    "tiers": [ { "tierIndex": 0, "threshold": 0, "collected": 0, "status": "ready" } ] } }
```

Тир: `threshold`, `collected`, `tierIndex`, `status` (`ready` — можно открыть).

**Блок виден только авторизованным.** В [useDepositChain-CTOMFCQw.js](../public/assets/js/useDepositChain-CTOMFCQw.js) запрос идёт с `enabled: isAuthed && isDepositChainEnabled` — гостю блок не покажется, что бы сервер ни ответил. Пустой `tiers` скрывает его и у авторизованных.

## Как быстро проверить ручку

```bash
curl -s http://localhost:3101/api/v1/cases/series | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s),null,2).slice(0,2000)))"
```
