# NewCasesRust — Kaban.gg / titanrust.ru

Платформа открытия кейсов Rust. Домен: **titanrust.ru**.

## Структура

```text
D:\NewCasesRust\
├── server.js                 # Игровой сервер: API /api/v1, WebSocket /ws, статика, SPA-роутинг
├── services\
│   ├── auth.js               # Авторизация через Steam OpenID 2.0, JWT, сессии
│   ├── inventory.js          # Инвентарь, продажа/вывод, статистика и история профиля
│   ├── battles.js            # Кейс-баттлы
│   ├── upgradeBattles.js     # Батлы на апгрейдах, расчёт и возвраты
│   ├── upgraderSettlement.js # Атомарное списание и выплата обычного апгрейдера
│   └── steamSync.js          # Синхронизация каталога скинов из Steam Market
├── public\                   # Собранный Vue 3 SPA игрового сайта (исходников в репо нет)
│   ├── index.html
│   ├── assets\{js,css,...}   # Бандл Vite: имена чанков = имена компонентов
│   ├── audio\ avatars\ icons\ image\ png\ svg\ packs\
│   └── uploads\              # Файлы, загруженные через админку
├── admin.titanrust.ru\
│   ├── public\               # Собранный SPA админки (shadcn-vue)
│   └── server\
│       ├── server.js         # Сервер админки: CRUD, загрузка файлов
│       └── database.sqlite   # ЕДИНСТВЕННАЯ база проекта
├── data\skins.json           # Кэш/фолбэк каталога скинов
├── docs\                     # Документация по проекту — начинать отсюда
└── .env.example              # Шаблон конфигурации (скопировать в .env)
```

## Запуск

```bash
npm install
```

```bash
npm start
```

| Что | Команда | Адрес |
|---|---|---|
| Игровой сайт | `npm start` | http://localhost:3101 |
| Админка | `npm run admin` | http://localhost:8080 |
| Синк скинов из Steam | `npm run sync-skins` | — |

Серверы независимы и поднимаются по отдельности. Настройки — в `.env` (шаблон: `.env.example`).

Локальная разработка без реального Steam-логина:

```bash
NODE_ENV= PUBLIC_URL=http://localhost:3101 ALLOW_MOCK_AUTH=1 npm start
```

## Продолжение работы

[save/](save/) — снимок состояния: что сделано, что осталось, грабли проекта.
После очистки контекста достаточно сказать: «прочитай save/ и продолжи».

## Документация

| Документ | О чём |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | как связаны три части проекта, поток данных БД → API → фронт |
| [docs/API-MAP.md](docs/API-MAP.md) | все эндпоинты обоих серверов, что живое, что заглушка |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | схема SQLite, редкости, картинки предметов |
| [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) | токены, палитра, типографика, правила правок UI |
| [docs/FRONTEND-MAP.md](docs/FRONTEND-MAP.md) | как найти код в собранном бандле |
| [docs/GAMEPLAY.md](docs/GAMEPLAY.md) | шансы, RTP, апгрейдер, баттлы, розыгрыши, честный бросок |
| [docs/CATALOG.md](docs/CATALOG.md) | каталог предметов Steam: обход, редкости, цены |
| [docs/ADMIN.md](docs/ADMIN.md) | разделы админки, фабрика CRUD, ловушки порядка роутов |
| [docs/AUTH.md](docs/AUTH.md) | вход через Steam, настройка домена, nginx |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | плейбуки по типовым багам |

## Реализовано

- SPA-роутинг: `/`, `/cases/:slug`, `/crate-pvp`, `/upgrader`, `/giveaway`, `/profile`, `/wallet` и др.
- Каталог кейсов, серий и предметов — живой, из базы админки.
- **Полный каталог Steam (5430 предметов)**: фоновый обход, картинки, цены в ₽, разбивка по 5 тирам редкости.
- **Авторизация**: Steam OpenID и вход по e-mail (scrypt), общая refresh-сессия.
- **Взвешенный розыгрыш** кейсов и апгрейдера с настраиваемым RTP и честным броском.
- **Баланс, кошелёк и история операций** в SQLite — переживают перезапуск.
- **Профиль** синхронизирован с `users`, `transactions` и `inventory`: имя, ID, статистика, лучший дроп и история игр.
- **Батлы на апгрейдах**: два игрока, три фиксированные цели, резерв взноса, возврат при отмене, проверяемый seed и восстановление комнаты после перезагрузки.
- **Инвентарь предметов**: выигрыш можно продать или отправить в заявку на вывод.
- **Passkey-вход в админку** (WebAuthn).
- Загрузка медиа через админку в общую папку `public/uploads`.
- WebSocket `/ws` с авторизацией по JWT, звуковое сопровождение, PWA-манифест.

## Пока не реализовано

- Автоматическая отправка Steam trade-offer: заявки сохраняются, но требуют ручной обработки.
- Пополнение скинами из Steam: нужен торговый бот и его сессия.
- Гонки — раздела нет в собранном фронте, нужна более новая сборка.


Подробности и текущий статус — в [docs/AUTH.md](docs/AUTH.md) и [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
