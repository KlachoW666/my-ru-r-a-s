# Kaban.gg (NewCasesRust) — архитектура

> Всё, что здесь написано, проверено по коду 2026-08-23 (рабочая копия `D:\NewCasesRust`, коммит `9cc3331` + незакоммиченные правки).

## 1. Три независимых процесса

Проект — это **не** монолит. Это два Express-сервера и одна SQLite-база, которую они делят.

```
┌─────────────────────────────────────────────────────────────────┐
│  ИГРОВОЙ САЙТ                          АДМИНКА                  │
│                                                                  │
│  public/index.html                     admin.titanrust.ru/       │
│  Vue 3 SPA (собранный бандл)             public/index.html       │
│  ↓ axios baseURL "/api/v1"             Vue 3 SPA (собранный)     │
│                                          ↓ "/api/v1/admin/*"     │
│  server.js                             admin…/server/server.js   │
│  PORT 3101 (по умолчанию)              PORT 8080 (по умолчанию)  │
│  + WebSocket на /ws                    + multer upload           │
│         │                                       │                │
│         │ read-only (SELECT)          read/write (CRUD)          │
│         └──────────────┬────────────────────────┘                │
│                        ▼                                         │
│      admin.titanrust.ru/server/database.sqlite                   │
│                        ▲                                         │
│                        │ INSERT/UPSERT                           │
│              services/steamSync.js  →  Steam Market API          │
└─────────────────────────────────────────────────────────────────┘
```

| Процесс | Файл | Порт | Запуск |
|---|---|---|---|
| Игровой сайт + API | [server.js](../server.js) | `PORT` или **3101** | `npm start` из корня |
| Админка + API | [admin.titanrust.ru/server/server.js](../admin.titanrust.ru/server/server.js) | `PORT` или **8080** | `npm start` из `admin.titanrust.ru/server` |
| Синк скинов | [services/steamSync.js](../services/steamSync.js) | — | `node services/steamSync.js` или `POST /api/v1/admin/sync-skins` |

Оба сервера нужно поднимать **отдельно**. Если админка не запущена — сайт всё равно работает: `queryAdminDb()` читает SQLite-файл напрямую, минуя админский HTTP-сервер.

## 2. Кто чем владеет

**`server.js` — только читает базу.** Ни один его роут не делает INSERT/UPDATE. Всё, что видит игрок (кейсы, серии, предметы, баннеры), приходит из таблиц админки через `queryAdminDb()`. Всё остальное (баланс, профиль, кошелёк, баттлы, розыгрыши, апгрейдер) — **моки в памяти процесса**: `mockUser`, `mockConfig`, `mockStats` в [server.js:265-310](../server.js:265). После рестарта состояние сбрасывается.

**`admin…/server.js` — владелец схемы.** `initDatabase()` ([:48](../admin.titanrust.ru/server/server.js:48)) создаёт таблицы, доливает недостающие колонки через `ALTER TABLE … , (err) => {}` (ошибка «колонка уже есть» глотается — это штатно) и сидит начальные данные: 3 серии, `SUPER_ADMIN / admin123`, 15 демо-скинов.

**`steamSync.js` — единственный писатель в `items`.** Берёт 20 захардкоженных проверенных скинов (`VERIFIED_RUST_SKINS`) + страницы Steam Market, пишет в `data/skins.json` и делает UPSERT в `items` по `market_hash_name`.

## 3. Ключевая цепочка: DB → API → фронт

Это тот путь, который ломается чаще всего.

```
cases / series / items / case_items  (SQLite)
   │
   │  server.js: queryAdminDb() → SELECT
   ▼
getLiveItems()   :64   items  → {id:"db-N", price, image, rarity, colorHex}
getLiveSeries()  :96   series + cases, отфильтровывает пустые серии,
                       неприсвоенные кейсы падают в «Популярные Кейсы» (id=1)
getLiveCases()   :204  плоский список, дедуп по slug
getLiveBanners() :215  banners WHERE active=1
getCaseItemsFromDb() :471  case_items JOIN items — содержимое конкретного кейса
   │
   ▼
GET /api/v1/cases/series → {status,data:{series:[…]}}
GET /api/v1/cases/:slug  → {status,data:{case:…, items:[…]}}
   │
   ▼
axios (baseURL "/api/v1") → Pinia store → Vue-компоненты
```

**Правило фолбэков.** Каждый шаг имеет тихий фолбэк: нет строк в БД → `getFallbackItems()` → захардкоженные 3-5 предметов. Поэтому *«на сайте не то, что в админке»* почти всегда означает не «сломан рендер», а «SELECT вернул 0 строк и сработал фолбэк». Проверять надо в таком порядке: данные в SQLite → ответ API (`curl`) → фронт.

## 4. Как файлы связаны между собой

| Связь | Где | Зачем знать |
|---|---|---|
| `server.js` → `services/steamSync.js` | импорт `SKINS_FILE`, `ADMIN_DB_PATH` ([:22](../server.js:22)) | путь к БД задан **в steamSync**, не в server.js |
| `server.js` → `sqlite3` из админки | `require(path.join(__dirname,'admin.titanrust.ru','server','node_modules','sqlite3'))` ([:45](../server.js:45)) | в корне пакета `sqlite3` нет; удалишь `node_modules` в админке — отвалится вся живая выдача сайта |
| админка → `public/uploads/` | multer пишет в `../../public/uploads/<folder>` ([:1017](../admin.titanrust.ru/server/server.js:1017)) | картинки, загруженные в админке, физически лежат в папке игрового сайта; оба сервера раздают `/uploads` |
| `steamSync.js` → `data/skins.json` | запись при каждом синке | это кэш/фолбэк, а не источник правды |
| `public/sw.js` | «self-destruct» service worker | см. [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

## 5. WebSocket

`server.js:914` — `WebSocketServer({ server, path: '/ws' })`. Логика минимальная: на коннект шлёт `{event:'connected'}`, на `{action:'auth'}` — `{event:'authenticated', data:{user: mockUser}}`. Broadcast-ов нет: live-дропы, онлайн и прочее фронт получает опросом REST.

## 6. Аутентификация

**Сайт:** её фактически нет. `/api/v1/auth/*` отдаёт `mockUser` и `token: "mock_token_12345"` ([server.js:585](../server.js:585)). Фронт кладёт токен в `localStorage["token"]` и шлёт `Authorization: Bearer`; refresh сериализован через `navigator.locks('kaban.auth-refresh')`.

**Админка:** JWT выписывается, но **не проверяется** — `requireAdminJWT()` ([:216](../admin.titanrust.ru/server/server.js:216)) просто подставляет `SUPER_ADMIN` и вызывает `next()`. Любой запрос к `/api/v1/admin/*` проходит. Это нормально для локальной разработки и недопустимо в проде.

## 7. Известные несоответствия

Перепроверено 2026-08-23 по актуальному коду.

### Исправлено

**Порты и WebSocket.** Было: README обещал 3030, сервер слушал 3101, в бандле стоял `ws://localhost:3030`. Сейчас README и `server.js` согласованы на 3101, а адрес WebSocket вычисляется из `window.location` — работает на любом порту и на боевом домене. Подробности — [TROUBLESHOOTING #7](TROUBLESHOOTING.md).

### Актуально

**1. Секреты имеют небезопасные значения по умолчанию.** `.env` в `.gitignore`, `.env.example` без боевых значений — это сделано. Но fallback остался прямо в коде:

| Файл | Значение по умолчанию |
|---|---|
| [services/steamSync.js:9](../services/steamSync.js:9) | реальный ключ Steam |
| [services/auth.js:38](../services/auth.js:38) | `titanrust_super_secret_jwt_key_2026` |
| [admin…/server.js:14](../admin.titanrust.ru/server/server.js:14) | то же значение |

Если `.env` не подхватится на проде, сервер **молча** поднимется на общеизвестном секрете и токены сможет подделать любой, кто видел репозиторий. Ключ Steam остался и в истории git — его стоит перевыпустить.

**2. `node_modules` остаются в индексе git — 626 файлов.** `.gitignore` создан, но он **не влияет на уже отслеживаемые файлы**. Отцепить: `git rm -r --cached node_modules`. `git status` сейчас — 31 строка.

**3. Шансы выпадения не работают, и интерфейс вводит в заблуждение.** `POST /api/v1/cases/open` ([server.js:625](../server.js:625)):

```js
const winningItem = items[Math.floor(Math.random() * items.length)];
```

Выбор равномерный. При этом `chance` из БД **отдаётся** игроку в ответе `/cases/:slug` ([server.js:576](../server.js:576)) — то есть на экране показаны одни шансы, а разыгрываются другие. `ticketRangeFrom/To`, RTP и волатильность из админки не используются вообще.

**4. Апгрейдер устроен так же** ([server.js:816](../server.js:816)):

```js
const won = Math.random() > 0.4;   // фиксированные 60% победы
const targetItem = skins[0];       // всегда самый дорогой предмет каталога
```

Вероятность не зависит ни от множителя, ни от ставки, ни от выбранного предмета. При победе на баланс начисляется цена самого дорогого скина в каталоге.

## См. также

- [API-MAP.md](API-MAP.md) — все эндпоинты обоих серверов
- [DATA-MODEL.md](DATA-MODEL.md) — схема SQLite и куда каждая колонка попадает на фронт
- [FRONTEND-MAP.md](FRONTEND-MAP.md) — как найти код в собранном бандле
- [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) — токены, типографика, палитра редкостей
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — плейбуки по типовым багам
