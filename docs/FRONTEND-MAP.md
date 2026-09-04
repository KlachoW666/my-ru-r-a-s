# Фронтенд: как найти код

## Главное, что нужно понимать

**Исходников Vue в репозитории нет.** В `public/` лежит собранный Vite-бандл: минифицированный JS, извлечённый CSS, ассеты. Того же касается `admin.titanrust.ru/public/`.

Практический вывод: правку UI можно либо **точечно внести в бандл** (быстро, но затрётся при следующей сборке), либо запросить исходники и собрать заново. Всегда оговаривай, какой вариант делаешь.

## Точки входа

| | Файл | Скрипт |
|---|---|---|
| Сайт | [public/index.html](../public/index.html) | `/assets/js/index-CyyoIbm1.js` — **без query-строки**, см. [TROUBLESHOOTING #0](TROUBLESHOOTING.md) |
| Админка | [admin.titanrust.ru/public/index.html](../admin.titanrust.ru/public/index.html) | `/assets/index-D4siiPNB.js` |

`index-CyyoIbm1.js` — рантайм-ядро сайта: там же `createRouter`, таблица маршрутов, инстанс axios и бутстрап-логика (в т.ч. `handleSteamCallback()` на старте).

## Имена чанков = имена компонентов

Vite сохранил осмысленные имена. Это главный инструмент навигации:

```bash
# найти чанк страницы
ls public/assets/js/ | grep -i profile
# → ProfilePage-cSVlEg4o.js

# найти стили той же страницы
ls public/assets/css/ | grep -i profile
# → ProfilePage-3kHoC3SJ.css
```

Хэш в имени (`-cSVlEg4o`) меняется при каждой пересборке — **никогда не хардкодь его**, ищи по префиксу.

## Маршруты SPA → чанки

Таблица роутов лежит в `index-CyyoIbm1.js`. Список путей:

| Путь | `name` | Чанк |
|---|---|---|
| `/` | `home` | `landing-*.js` / `index-*.js` |
| `/cases/:slug` | `case` | `cards-*.js`, `case-reel-*.js` |
| `/crate-pvp` | `crate-pvp` | `BattleLobbyPage-*.js` |
| `/crate-pvp/create` | `crate-pvp-create` | `BattleCreatePage-*.js` |
| `/crate-pvp/:uid` | `crate-pvp-battle` | `BattleGamePage-*.js` |
| `/crate-pvp?mode=upgrade` | `crate-pvp` | исходный лобби-чанк + `upgrade-battle-page.js` |
| `/upgrader` | `upgrader` | `index-*.js` (upgrader) |
| `/giveaway`, `/giveaway/create`, `/giveaway/history` | `giveaway*` | `giveaway-*.js`, `giveaway-create-*.js`, `giveaway-layout-*.js` |
| `/profile` | `user-profile` | `ProfilePage-*.js` |
| `/profile/connections` | `profile-connections` | `ConnectionsPage-*.js` |
| `/wallet`, `/wallet/withdraw`, `/wallet/return` | `wallet*` | `WalletPage-*.js`, `CardDepositReturnPage-*.js` |
| `/history` | `transaction-history` | `TransactionHistoryPage-*.js` |
| `/topdrops` | `topdrops` | `index-*.js` |
| `/streamer/statistics` | `streamer-statistics` | `streamer-statistics-*.js` |
| `/banned` | `banned` | `BannedPage-*.js` |
| `/auth/google/callback` | `google-callback` | `GoogleCallbackPage-*.js` |
| `/auth/reset-password`, `/auth/verify-email` | | `ResetPasswordPage-*.js`, `VerifyEmailPage-*.js` |
| `/terms-and-conditions`, `/privacy-policy`, `/refund-policy`, `/cookie-policy` | | `content-*.js` |
| `/dev/components` | `dev-components` | `ComponentGallery-*.js` — витрина компонентов, полезна для проверки дизайна |

Проверить актуальный список:

```bash
grep -oh 'path:"[^"]*",name:"[^"]*"' public/assets/js/*.js | sort -u
```

## Ключевые модули

| Что | Файл | Внутри |
|---|---|---|
| axios-клиент | `public/assets/js/mutator-*.js` | `baseURL:"/api/v1"`, timeout 15 с, `withCredentials:true`, Bearer из `localStorage["token"]`, refresh-очередь на `navigator.locks("kaban.auth-refresh")`. **Возвращает `response.data`, а не объект axios** |
| auth-стор | `public/assets/js/store-DveOaq2e.js` | `refreshSession()`, `logout()`, `handleSteamCallback()`, `finalizeOAuthReturn()` |
| user-стор | `public/assets/js/store-CliSAPz5.js` | `/user`, `/user/stats`, `/history`, `/user/ban-status`, trade-link. Важно: ждёт `userId/displayName/tradeUrl` и `totalCases/totalUpgrades/totalBattles` |
| батлы на апгрейдах | `public/assets/js/upgrade-battle-page.js` | лобби, поиск целей, создание, вход, возврат, восстановление по `uid` |
| WebSocket | `public/assets/js/index-CBN0naXL.js` | синглтон-клиент, реконнект, ключ токена `"token"`, адрес WS вычисляется из `window.location` |
| Редкости | `public/assets/js/rarity-DBZTLmta.js` | `{REGULAR,UNUSUAL,RARE,VIOLET,GOLD} → hex` |
| i18n | `public/assets/js/en-*.js`, `tr-*.js` | ru — в основном бандле. Локаль из `localStorage`, отдельных URL под язык нет |
| Аналитика | `public/assets/js/analytics-events-*.js`, `posthog-*.js` | PostHog |
| Чат поддержки | `public/assets/js/chatwoot-*.js` | Chatwoot |

## Формат ответа, который ждёт фронт

axios-мутатор разворачивает ответ до тела. Дальше код обращается к `.data`:

```js
// Стандартный конверт сервера:
{ "status": "success", "data": { … } }

// на фронте:  const r = await api(...);  r.data.accessToken
```

Поэтому новый эндпоинт **обязан** класть полезную нагрузку в `data`, иначе фронт увидит `undefined`.

## Как искать в минифицированном коде

```bash
# по строковому литералу (URL, ключ localStorage, текст)
grep -l '"/user/tradeurl"' public/assets/js/*.js

# с контекстом — минифицированный код в одну строку, поэтому берём окно символов
grep -o '.\{200\}handleSteamCallback.\{400\}' public/assets/js/store-DveOaq2e.js

# какие эндпоинты дёргает конкретный стор
grep -oh 'url:"/[a-z0-9/_:-]*"' public/assets/js/store-*.js | sort -u
```

Имена переменных минифицированы (`e`, `t`, `o`), а строковые литералы — нет. **Ищи всегда по литералам**: URL, ключам localStorage, названиям событий, текстам.

## Граф знаний

Для «в каком файле лежит X» быстрее graphify, чем grep по 231 чанку:

```bash
cd /d/NewCasesRust && graphify query "где обрабатывается открытие кейса"
```

Оговорка: код бандла минифицирован, поэтому узлы графа часто называются `ut()`, `Q()`, `_f()`. Граф хорошо отвечает на «какие файлы связаны», плохо — на «что делает эта функция». Для второго читай литералы через grep.

Обновить граф после правок: `graphify update .` (без LLM, бесплатно).

## Кэширование при разработке

`server.js` уже отдаёт `Cache-Control: no-store` для `index.html` и для `.js`/`.html` внутри `/assets` ([:878](../server.js:878), [:899](../server.js:899)). Если правка бандла всё равно не видна — см. [TROUBLESHOOTING.md](TROUBLESHOOTING.md), почти наверняка это service worker.


---

## Слой ребрендинга SATCHEL

Исходников Vue нет, поэтому бренд наложен поверх сборки. Всё, что придётся
переносить на следующую пересборку фронта:

| Что | Файл | Переживёт пересборку? |
|---|---|---|
| Токены темы | `assets/css/satchel-theme.css` | да, скопировать |
| Подключение темы | `index.html`, последний `<link>` | нет, добавить заново |
| Логотип в бандле | `assets/js/logo-full-*.js`, `logo-symbol-*.js` | нет, переписать |
| Водяные знаки | `assets/js/hog-ghost-*.js`, `hog-shamp-*.js`, `assets/svg/hog-shamp-*.svg` | нет, переписать |
| Строки бренда | 5 чанков, 155 замен | нет, прогнать заново |
| Перекраска лайма | 35 файлов, 101 замена + 4 в URL-кодировке + 1 base64 | нет, прогнать заново |
| Ассеты | `public/brand/`, иконки, `assets/battles/*`, `assets/cases/satchel/` | да, скопировать |

Три чанка переписаны целиком (логотипы и водяные знаки): там фигуры прежнего
бренда нарисованы контурами, и перекраски было недостаточно. Контракт модуля
у всех трёх сохранён дословно — `export { m as default, render }`, — его ждёт
карта иконок в `index.vue_*.js`.

Подробности и список намеренно сохранённых внутренних идентификаторов:
[SATCHEL-REBRAND.md](SATCHEL-REBRAND.md).
Что осталось невыполненным и почему: [../DESIGN_MIGRATION_BLOCKERS.md](../DESIGN_MIGRATION_BLOCKERS.md).
