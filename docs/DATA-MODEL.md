# Модель данных

Единственная база: **`admin.titanrust.ru/server/database.sqlite`**. Путь задан в двух местах — [admin…/server.js:14](../admin.titanrust.ru/server/server.js:14) (`DB_PATH`) и [services/steamSync.js:11](../services/steamSync.js:11) (`ADMIN_DB_PATH`, его импортирует корневой `server.js`).

Схема создаётся в `initDatabase()` ([admin…/server.js:48](../admin.titanrust.ru/server/server.js:48)). Внешних ключей нет — связи только по соглашению.

## Схема

```
series ──1:N──> cases ──1:N──> case_items ──N:1──> items
  (id)         (seriesId)      (case_id)          (item_id)

banners   pages   users   withdrawals   admin_users     (изолированы)
```

### `items` — каталог скинов

| Колонка | Тип | Смысл |
|---|---|---|
| `id` | INTEGER PK | |
| `market_hash_name` | TEXT **UNIQUE** | ключ апсерта из Steam |
| `name`, `price` | TEXT, REAL | цена в ₽ |
| `rarity` | TEXT | Steam-редкость: `COVERT`/`CLASSIFIED`/`RESTRICTED`/`MIL_SPEC`/`INDUSTRIAL`/`CONSUMER`/`REGULAR` |
| `color` | TEXT | hex **без** `#` |
| `image` | TEXT | абсолютный URL Steam CDN или локальный `/uploads/…` |
| `chance`, `ticketRangeFrom`, `ticketRangeTo` | REAL/INT | **сервером не используются** (см. ниже) |
| `upgraderEnabled` | INTEGER | попадает в апгрейдер |
| `updated_at` | TIMESTAMP | |

Пишет сюда `syncRustSkins()` ([steamSync.js:127](../services/steamSync.js:127)) через `INSERT … ON CONFLICT(market_hash_name) DO UPDATE`. Перед апсертом выполняется `DELETE FROM items WHERE image LIKE '%-9a81dl%'` — чистка «битых» сид-картинок из `initDatabase()`.

### `cases`

`slug` UNIQUE — именно по нему фронт ходит на `/cases/:slug`. Колонки `isActive`, `status`, `archived`, `exclusiveTo`, `category` добавлены через `ALTER TABLE` поверх исходного `CREATE`, поэтому в существующих строках могут быть `NULL`.

Фильтры чтения различаются, и это ловушка:

| Где | Условие |
|---|---|
| `getLiveSeries()` (сайт) | `WHERE archived = 0` |
| `GET /cases/:slug` (сайт) | `WHERE slug = ? OR id = ?` — **без фильтра активности** |
| фолбэк там же | `WHERE archived = 0 OR isActive = 1 LIMIT 1` |

То есть заархивированный кейс исчезает из каталога, но остаётся открываемым по прямой ссылке.

### `series`

`status`, `description`, `image`, `titleImage`, `sortOrder`, `isLimited`, `isSecret`. Сайт читает `WHERE status = 'active'`. **Серия без единого кейса не отдаётся вообще** ([server.js:113](../server.js:113)) — частая причина «создал серию, а её нет на сайте».

### `case_items` — состав кейса

`UNIQUE(case_id, item_id)` — один предмет в кейсе только один раз. `chance` и `ticketRangeFrom/To` заполняет админка, но `POST /cases/open` их **не читает**: выбор идёт `items[Math.floor(Math.random()*items.length)]` ([server.js:534](../server.js:534)). Шансы, RTP и волатильность из админки на реальное выпадение не влияют — это надо чинить в `server.js`, а не в админке.

### Остальные

- `banners` — `title`, `image`, `url`, `position`, `active`. Сайт: `WHERE active = 1 ORDER BY position`. Поля `description`/`buttonText`/цвета/`video` в БД **нет** — `getLiveBanners()` подставляет их константами ([server.js:219](../server.js:219)), меняется только картинка и ссылка.
- `users` — `steam_id`, `balance`, `rtp` (дефолт 95.0), `role`, `status`. Игровой сервер эту таблицу **не читает** — игрок всегда `mockUser`.
- `withdrawals`, `pages`, `admin_users` (сид: `SUPER_ADMIN` / `admin123`).

> **Обновлено:** каталог теперь наполняет [services/steamCatalog.js](../services/steamCatalog.js), редкость берётся из `name_color` Steam, а не из цены. Актуальное описание — [CATALOG.md](CATALOG.md). Ниже — как это устроено со стороны БД.

## Редкости: три системы имён

Это источник багов с цветами. Есть три словаря, и они не совпадают.

| Слой | Значения |
|---|---|
| БД / Steam (`items.rarity`) | `COVERT`, `CLASSIFIED`, `RESTRICTED`, `MIL_SPEC`, `INDUSTRIAL`, `CONSUMER`, `REGULAR` |
| API после `mapRarity()` ([server.js:461](../server.js:461)) | `GOLD`, `VIOLET`, `RARE`, `UNUSUAL`, `REGULAR` |
| Фронт ([public/assets/js/rarity-DBZTLmta.js](../public/assets/js/rarity-DBZTLmta.js)) | те же 5 → hex |

```
COVERT   | MYTHIC    | GOLD     →  GOLD     #ffc43b
CLASSIFIED | LEGENDARY | VIOLET →  VIOLET   #a33ee2
RESTRICTED | RARE               →  RARE     #65dc04
MIL_SPEC | UNUSUAL              →  UNUSUAL  #4076ff
всё остальное                   →  REGULAR  #756767
```

**Дыры в маппинге:** `INDUSTRIAL` и `CONSUMER` (их сидит `initDatabase()`) не перечислены в `mapRarity` и падают в `REGULAR` — серый цвет вместо голубого. `getRarity()` в [steamSync.js:96](../services/steamSync.js:96) вдобавок переопределяет редкость **по цене**, а не по цвету Steam (`≥8000 → COVERT`, `≥2500 → CLASSIFIED`, `≥800 → RESTRICTED`, `≥200 → MIL_SPEC`), поэтому после синка редкость может не совпасть с реальной Steam-редкостью.

## Картинки предметов

`fixImageUrl()` ([server.js:2](../server.js:2)) — единственная нормализация:
- `community.steamstatic.com` → `community.cloudflare.steamstatic.com`
- голый хэш, начинающийся с `-9a81dl` → приклеивает `https://community.cloudflare.steamstatic.com/economy/image/`
- пусто → `/assets/battles/winner-boar.png`

Локальные загрузки из админки лежат в `public/uploads/{cases,series,banners,items,general}/` и раздаются **обоими** серверами.

## Работа с базой напрямую

```bash
cd D:/NewCasesRust/admin.titanrust.ru/server && node -e "const s=require('sqlite3').verbose();const db=new s.Database('database.sqlite');db.all('SELECT id,slug,name,price,seriesId,archived FROM cases ORDER BY sortOrder',(e,r)=>{console.table(r);db.close()})"
```

Сервер держит соединение открытым, но SQLite допускает параллельное чтение. Перед `UPDATE`/`DELETE` останавливай админку, иначе можно поймать `SQLITE_BUSY`.
