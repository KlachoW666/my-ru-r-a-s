# Авторизация через Steam (titanrust.ru)

Реализована в [services/auth.js](../services/auth.js), подключается одной строкой в [server.js](../server.js): `registerAuthRoutes(app, { mockUser })`.

Внешних зависимостей нет: JWT подписывается через `crypto` (HS256), OpenID-верификация — через `https`. `.env` читается встроенным `process.loadEnvFile()` (Node ≥ 20.12).

## Полный цикл

```
1. Игрок жмёт «Войти через Steam»
   Фронт делает full-page переход:
   GET /api/v1/auth/steam?tos_accepted=true&is_adult=true&redirect_to=https://titanrust.ru

2. Сервер отвечает 302 на Steam OpenID 2.0:
   https://steamcommunity.com/openid/login
     ?openid.mode=checkid_setup
     &openid.realm=https://titanrust.ru            ← PUBLIC_URL
     &openid.return_to=https://titanrust.ru/api/v1/auth/steam/return?rt=<redirect_to>
     &openid.identity=…identifier_select
   redirect_to едет ВНУТРИ return_to: Steam подписывает return_to целиком,
   поэтому подменить его по дороге нельзя — проверка на шаге 4 упадёт.

3. Игрок логинится в Steam, Steam возвращает браузер на return_to
   с параметрами openid.* и подписью.

4. GET /api/v1/auth/steam/return
   a) POST на steamcommunity.com с openid.mode=check_authentication
      → ждём "is_valid:true", иначе 302 на /?auth_error=steam_verification_failed
   b) из openid.claimed_id достаём SteamID64 (regex, ровно 17 цифр)
   c) GetPlayerSummaries по STEAM_API_KEY → ник, аватар, ссылка на профиль
   d) UPSERT в таблицу users по steam_id
   e) выписываем два токена:
        access  (1 ч)  — в URL
        refresh (30 д) — в httpOnly-cookie kaban_rt
   f) 302 на <redirect_to>/#access_token=<JWT>

5. SPA на загрузке зовёт store.handleSteamCallback(): читает hash,
   кладёт токен в localStorage["token"], чистит URL через replaceState.

6. Дальше каждый запрос идёт с Authorization: Bearer <access>.
   Когда access протухает — axios ловит 401 и зовёт GET /auth/refresh,
   который по cookie выдаёт новый access. Параллельные refresh
   сериализуются через navigator.locks("kaban.auth-refresh").
```

## Эндпоинты

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/v1/auth/steam` | 302 в Steam. Параметр `redirect_to` валидируется по allowlist |
| GET | `/api/v1/auth/steam/return` | проверка подписи, upsert пользователя, выдача токенов |
| GET | `/api/v1/auth/refresh` | `{data:{accessToken}}` из refresh-cookie, иначе 401 |
| GET | `/api/v1/auth/me` | `{data:{user}}` |
| ALL | `/api/v1/auth/logout` | чистит cookie |
| GET | `/api/v1/user` и алиасы | профиль текущего пользователя, 401 без токена |
| PUT | `/api/v1/user/{tradeurl,display-name,avatar}` | пишет в `users`, если авторизован |
| * | `/api/v1/auth/{login,register,verify,…}/email` | **501** — вход по e-mail не подключён |

## Настройки (`.env`)

| Переменная | Смысл | Дефолт |
|---|---|---|
| `PUBLIC_URL` | канонический адрес; уходит в Steam как `realm` | `https://titanrust.ru` |
| `ALLOWED_ORIGINS` | доп. адреса для `redirect_to`, через запятую | — |
| `COOKIE_DOMAIN` | домен refresh-cookie | `.titanrust.ru` при `NODE_ENV=production` |
| `STEAM_API_KEY` | Steam Web API | значение из репозитория (**ротировать**) |
| `JWT_SECRET` | подпись токенов | небезопасный дефолт |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | сек. | 3600 / 2592000 |
| `ALLOW_MOCK_AUTH` | `1` — отдавать `mockUser` без токена | вкл. вне `NODE_ENV=production` |
| `ADMIN_REQUIRE_AUTH` | `1` — включить реальную проверку JWT в админке | `0` |

`PUBLIC_URL` должен **точно** совпадать с адресом, по которому реально открывается сайт. Steam сверяет `realm` и `return_to`: если сайт на `https://www.titanrust.ru`, а realm — `https://titanrust.ru`, Steam вернёт ошибку. Слэша в конце быть не должно.

## Защита

- **Open redirect закрыт.** `redirect_to` сверяется с allowlist (`safeRedirectTarget`), чужой домен схлопывается в `PUBLIC_URL`. Проверено: `?redirect_to=https://evil.example.com` → `rt=https://titanrust.ru`.
- **Подпись Steam проверяется на стороне Steam** (`check_authentication`), а не локально. Поддельный `openid.sig` → редирект с `auth_error=steam_verification_failed`.
- **JWT сверяется `timingSafeEqual`.** Подделанный токен → 401.
- **Refresh-токен httpOnly + SameSite=Lax + Secure** (Secure только при `NODE_ENV=production`).
- `app.set('trust proxy', 1)` — иначе за nginx `req.protocol` всегда `http` и Secure-cookie не поставится.
- CORS: `origin: true` + `credentials: true`. С `origin:'*'` браузер отбрасывает ответы на запросы с `withCredentials`.

## Локальная разработка

```bash
NODE_ENV= PUBLIC_URL=http://localhost:3101 ALLOW_MOCK_AUTH=1 npm start
```

При `ALLOW_MOCK_AUTH=1` `/auth/refresh` выдаёт токен для `mockUser`, и сайт работает как раньше — без реального Steam. `localhost` уже в allowlist для не-production.

Проверить редирект, не заходя в Steam:

```bash
curl -s -o /dev/null -D - "http://localhost:3101/api/v1/auth/steam?redirect_to=https%3A%2F%2Ftitanrust.ru" | grep -i location
```

## Что ещё не сделано

1. **Баланс и открытие кейсов всё ещё моковые.** `POST /cases/open` списывает с `mockUser.balance` в памяти процесса, а не с `users.balance` авторизованного игрока. Это следующий логичный шаг: перевести экономику на строку в БД.
2. **Вход по e-mail** отдаёт 501 — фронт такие экраны рисует, бэка нет.
3. **Админка ходит по WebAuthn** (`/admin/auth/login/options` + `/verify` с `optionsJson`/`challengeId`), а сервер отвечает старой заглушкой без `optionsJson`. Passkey-логин админки нерабочий; сейчас держится на том, что `requireAdminJWT` пропускает всех. Перед публикацией админки на домен нужно либо реализовать WebAuthn, либо выставить `ADMIN_REQUIRE_AUTH=1` и сделать обычный вход по паролю из `admin_users`.
4. **`STEAM_API_KEY` и `JWT_SECRET` лежали в репозитории открытым текстом.** Сейчас читаются из `.env` (в `.gitignore`), но старые значения остались в истории git — ключ Steam стоит перевыпустить на https://steamcommunity.com/dev/apikey.

## Настройка nginx

```nginx
server {
    server_name titanrust.ru www.titanrust.ru;

    location / {
        proxy_pass http://127.0.0.1:3101;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;   # нужен для Secure-cookie
    }

    location /ws {
        proxy_pass http://127.0.0.1:3101;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
    }
}
```

Блок `location /ws` обязателен: без него апгрейд соединения не проходит и WebSocket молча падает в реконнект-цикл. Адрес фронт вычисляет сам из `window.location` — на `titanrust.ru` это `wss://titanrust.ru/ws`. См. [TROUBLESHOOTING.md](TROUBLESHOOTING.md#7-websocket-не-подключается).

WS-протокол авторизации: клиент шлёт `{action:"auth", token:<access JWT>}` (тот же токен, что в `Authorization`), сервер проверяет подпись и отвечает `{event:"authenticated", data:{user}}` либо `{event:"unauthorized"}`.
