# Выкладка на titanrust.ru и admin.titanrust.ru

Два домена, два процесса, одна база.

| Домен | Что | Порт | Сервис |
|---|---|---|---|
| `titanrust.ru` | игровой сайт, API, WebSocket | 3101 | `titanrust` |
| `admin.titanrust.ru` | админка | 8080 | `titanrust-admin` |

База одна — `admin.titanrust.ru/server/database.sqlite`. Создаёт и мигрирует её админка, поэтому она поднимается первой (`Before=titanrust.service` в юните).

## Первая установка

```bash
sudo adduser --system --group --home /var/www/titanrust titanrust
sudo -u titanrust git clone https://github.com/KlachoW666/my-ru-r-a-s.git /var/www/titanrust
```

```bash
cd /var/www/titanrust && sudo -u titanrust cp .env.example .env && sudo -u titanrust nano .env
```

Заполнить обязательно: `JWT_SECRET` (иначе процесс завершится сразу), `STEAM_API_KEY`, `SMTP_*`. Проверить, что `PUBLIC_URL=https://titanrust.ru` и `ADMIN_RP_ID=titanrust.ru`.

Секрет генерируется так:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Зависимости ставятся в двух местах — в корне и в сервере админки:

```bash
cd /var/www/titanrust && npm ci --omit=dev && cd admin.titanrust.ru/server && npm ci --omit=dev
```

Сервисы:

```bash
sudo cp /var/www/titanrust/deploy/systemd/*.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now titanrust-admin titanrust
```

nginx:

```bash
sudo cp /var/www/titanrust/deploy/nginx/*.conf /etc/nginx/sites-available/ && sudo ln -sf /etc/nginx/sites-available/titanrust.ru.conf /etc/nginx/sites-available/admin.titanrust.ru.conf /etc/nginx/sites-enabled/
```

```bash
sudo certbot --nginx -d titanrust.ru -d www.titanrust.ru -d admin.titanrust.ru && sudo nginx -t && sudo systemctl reload nginx
```

## Завести владельца и закрыть админку

Сразу после первого запуска, **до** того как домен станет доступен снаружи: пока `ADMIN_REQUIRE_AUTH=0`, админка пускает любой запрос без токена.

Вход сделан по ключу доступа. Passkey тоже работает, но требует настроенного аутентификатора — Windows Hello, Touch ID или USB-брелка; пока их нет, войти было бы нечем.

Первый ключ выдать некому, поэтому он создаётся из консоли:

```bash
cd /var/www/titanrust && node deploy/make-key.js --role SUPER_ADMIN
```

Скрипт напечатает ключ вида `trk_…`. **Сохраните его сразу**: в базе лежит только SHA-256, показать повторно невозможно. Потеряли — выпишите новый, старый отзовите.

Вход: `https://admin.titanrust.ru/key-login.html`

Страница кладёт токен туда же, откуда его читает панель, и уходит на главную — дальше всё как обычно. После этого закрываем вход всем остальным:

```bash
cd /var/www/titanrust && sed -i "s/^ADMIN_REQUIRE_AUTH=.*/ADMIN_REQUIRE_AUTH=1/" .env && pm2 restart admin-panel --update-env
```

### Ключи остальным администраторам

Владелец выписывает их сам:

```bash
curl -s -X POST https://admin.titanrust.ru/api/v1/admin/admins/keys -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"username":"Ivan","role":"MODERATOR","days":90}'
```

Роли описаны в [../docs/ADMIN.md](../docs/ADMIN.md#права-доступа). Выписывать ключи может только владелец: раздел закрыт доменом `admins`.

С сервера то же самое делается так:

```bash
cd /var/www/titanrust && node deploy/make-key.js --username Ivan --role MODERATOR --days 90
```

Посмотреть выданные и отозвать:

```bash
cd /var/www/titanrust && node deploy/make-key.js --list
```

```bash
cd /var/www/titanrust && node deploy/make-key.js --revoke 3
```

### Если что-то не так

| Симптом | Причина |
|---|---|
| «Ключ недействителен» | ключ отозван, истёк или скопирован не целиком — ответ одинаковый намеренно, чтобы по нему нельзя было узнать, существовал ли ключ |
| «Слишком много попыток» | сработало ограничение перебора: 10 неудач с одного адреса за 15 минут |
| Панель открывается и сразу выкидывает | токен просрочен, войдите заново на `/key-login.html` |
| `Request failed with status code 409` на passkey | ни одного ключа WebAuthn не заведено — это ожидаемо, пользуйтесь входом по ключу |

## Если сервер уже развёрнут со старого коммита

Файлов `deploy/` на нём ещё нет — достаньте их из origin, дальше всё обычным путём:

```bash
cd /var/www/titanrust && git fetch origin main && git checkout origin/main -- deploy/ && bash deploy/update.sh
```

В первом коммите в git лежали `node_modules` и `database.sqlite`. Потом их из индекса убрали, а на сервере `npm install` успел пересобрать нативные модули — поэтому `git pull` встаёт с «Your local changes would be overwritten by merge», перечисляя полсотни файлов `node_modules`.

`update.sh` этот случай разбирает сам: расхождения в `node_modules` и в файле базы снимает молча (в новом дереве этих путей нет, терять там нечего), базу перед этим копирует и возвращает на место. А вот правку в исходниках он не тронет — остановится и покажет, что именно изменено.

## Обновление

```bash
cd /var/www/titanrust && ./deploy/update.sh
```

Под своим пользователем, если он заведён:

```bash
cd /var/www/titanrust && sudo -u titanrust ./deploy/update.sh
```

Скрипт: снимает копию базы → забирает код из `origin/main` → ставит зависимости → перезапускает оба сервиса → проверяет, что они отвечают. Если не ответили — сам возвращает код на прежний коммит.

Посмотреть, что будет сделано, ничего не меняя:

```bash
cd /var/www/titanrust && ./deploy/update.sh --dry-run
```

Настройки под конкретную машину — в `deploy/deploy.conf` (образец рядом, в git не попадает). Скрипт сам находит systemd или pm2, но имена процессов должен знать: посмотрите `pm2 list` и пропишите их.

```bash
cp deploy/deploy.conf.example deploy/deploy.conf && nano deploy/deploy.conf
```

## Что скрипт намеренно не делает

- **Не зовёт `git clean`.** Загрузки из админки (`public/uploads/`) и `.env` не отслеживаются git — `git reset --hard` их не тронет, а `clean` снёс бы.
- **Не трогает базу.** Она вынута из репозитория именно поэтому: пока файл был отслеживаемым, `reset --hard` затирал бы боевые данные копией из коммита. Восстановление из копии — руками, чтобы случайно не потерять записанное после снимка.
- **Не перезаписывает `.env`.** Новые переменные надо переносить из `.env.example` самому.

## Если что-то пошло не так

```bash
sudo journalctl -u titanrust -n 100 --no-pager
```

```bash
sudo journalctl -u titanrust-admin -n 100 --no-pager
```

| Симптом | Причина |
|---|---|
| Процесс падает сразу после старта | `JWT_SECRET` не задан или оставлен по умолчанию — при `NODE_ENV=production` это осознанный `exit 1` |
| Зайти можно без входа, под чужим профилем | `NODE_ENV` не равен `production`: включён `ALLOW_MOCK_AUTH`, и сервер отдаёт моковый профиль любому запросу без токена |
| 502 от nginx, хотя `curl` на порт отвечает | `proxy_pass` смотрит не на тот порт. Сверьте его с `PORT` из `.env` |
| Steam возвращает ошибку авторизации | `PUBLIC_URL` не совпадает с адресом в браузере; `www` должен редиректить на голый домен |
| Игрока разлогинивает сразу после входа | `PUBLIC_URL` не совпадает с адресом в браузере, либо `COOKIE_DOMAIN` не покрывает домен. Флаг `Secure` зависит от `NODE_ENV`, а не от заголовков nginx |
| Лента дропов пустая, в консоли реконнект | нет блока `location /ws` или он объявлен после `location /` |
| Passkey не регистрируется | `ADMIN_RP_ID` не равен домену в адресной строке |
| Сайт не отдаёт данные | снесли `admin.titanrust.ru/server/node_modules` — игровой сервер берёт `sqlite3` оттуда |

Остальное — в [../docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md).
