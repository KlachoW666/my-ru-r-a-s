#!/usr/bin/env bash
#
# Разовая расчистка сервера, который стоит на первом коммите.
#
# Зачем нужен отдельно от update.sh: в первом коммите в git лежали
# `node_modules` и `database.sqlite`. Потом их из индекса убрали, а на сервере
# npm install успел пересобрать нативные модули — и `git pull` встаёт с
# «Your local changes would be overwritten by merge», перечисляя полсотни
# файлов node_modules. Обычное обновление такой узел не развяжет, потому что
# оно намеренно отказывается работать при изменениях в дереве.
#
# Что делает:
#   1. снимает копию базы — дальше будет reset --hard, а база отслеживалась,
#      и reset её удалит;
#   2. проверяет, что .env на месте: без него боевой сервер не поднимется;
#   3. переводит дерево на origin/main, стирая расхождения;
#   4. возвращает базу на место;
#   5. ставит зависимости заново — reset снёс отслеживаемые node_modules;
#   6. перезапускает процессы и проверяет, что оба отвечают.
#
# Запускается ОДИН раз. Дальше — только ./deploy/update.sh
#
#   cd /var/www/titanrust && bash deploy/first-update.sh

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
SITE_SERVICE="${SITE_SERVICE:-}"
ADMIN_SERVICE="${ADMIN_SERVICE:-}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"

[ -f "$SCRIPT_DIR/deploy.conf" ] && . "$SCRIPT_DIR/deploy.conf"

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_ERR=''; C_WARN=''; C_OFF=''
fi
step() { printf '\n%s==>%s %s\n' "$C_OK" "$C_OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    %s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
die()  { printf '\n%sОшибка:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

cd "$APP_DIR"

# ---------------------------------------------------------------------------

step "Проверка"
info "каталог: $APP_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || die "$APP_DIR — не git-репозиторий"
info "сейчас: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

DB_PATH="$APP_DIR/admin.titanrust.ru/server/database.sqlite"

# .env проверяем ДО reset: после него код требует JWT_SECRET, и при
# NODE_ENV=production процесс завершится сразу, если секрет не задан.
if [ ! -f "$APP_DIR/.env" ]; then
  warn ".env не найден."
  warn "После обновления код читает секреты только из него, а при"
  warn "NODE_ENV=production молча не стартует с секретом по умолчанию."
  warn ""
  warn "Сделайте это до продолжения, в другом окне:"
  warn "  cp .env.example .env"
  warn "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
  warn "  nano .env      # JWT_SECRET, STEAM_API_KEY, PUBLIC_URL, ADMIN_*"
  warn ""
  printf '    Продолжить без .env? [y/N] '
  read -r answer
  case "$answer" in [yY]*) ;; *) die "остановлено" ;; esac
fi

# ---------------------------------------------------------------------------

step "Копия базы"
if [ -f "$DB_PATH" ]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/database-before-first-update-$(date +%Y%m%d-%H%M%S).sqlite"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
  else
    cp "$DB_PATH" "$BACKUP_FILE"
  fi
  info "$BACKUP_FILE"
  info "размер: $(du -h "$BACKUP_FILE" | cut -f1)"
else
  BACKUP_FILE=""
  warn "базы нет — создастся при первом запуске админки"
fi

# ---------------------------------------------------------------------------

step "Перевод дерева на $REMOTE/$BRANCH"
warn "локальные расхождения будут стёрты — это и есть смысл расчистки"
git fetch "$REMOTE" "$BRANCH" --tags
TARGET="$(git rev-parse "$REMOTE/$BRANCH")"
info "цель: $(git rev-parse --short "$TARGET") $(git log -1 --format=%s "$TARGET")"

git reset --hard "$TARGET"
info "дерево переведено"

# reset снёс отслеживаемые node_modules и, если база отслеживалась, её тоже.
if [ -n "$BACKUP_FILE" ] && [ ! -f "$DB_PATH" ]; then
  cp "$BACKUP_FILE" "$DB_PATH"
  info "база возвращена из копии (reset удалил её как отслеживаемый файл)"
elif [ -n "$BACKUP_FILE" ]; then
  info "база на месте, не тронута"
fi

# ---------------------------------------------------------------------------

step "Зависимости заново"
info "их снёс reset вместе с отслеживаемыми файлами — ставим с нуля"
( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund )
( cd "$APP_DIR/admin.titanrust.ru/server" && npm ci --omit=dev --no-audit --no-fund )

# Игровой сервер берёт sqlite3 из node_modules админки: без него сайт
# поднимется, но вся живая выдача будет пустой.
[ -d "$APP_DIR/admin.titanrust.ru/server/node_modules/sqlite3" ] \
  || die "sqlite3 не встал в admin.titanrust.ru/server/node_modules"
info "sqlite3 на месте"

# ---------------------------------------------------------------------------

step "Перезапуск"

# Имена процессов не угадываем: спрашиваем pm2, что у него есть.
if command -v pm2 >/dev/null 2>&1; then
  if [ -z "$SITE_SERVICE" ] || [ -z "$ADMIN_SERVICE" ]; then
    info "процессы pm2:"
    pm2 list --no-color 2>/dev/null | sed 's/^/        /' || true
    warn "имена сервисов не заданы. Перезапустите сами и пропишите их"
    warn "в deploy/deploy.conf, чтобы update.sh делал это без вопросов:"
    warn "  SITE_SERVICE=<имя сайта>"
    warn "  ADMIN_SERVICE=<имя админки>"
  else
    pm2 restart "$ADMIN_SERVICE" --update-env
    pm2 restart "$SITE_SERVICE" --update-env
    info "перезапущены: $ADMIN_SERVICE, $SITE_SERVICE"
  fi
else
  warn "pm2 не найден — перезапустите процессы сами"
fi

# ---------------------------------------------------------------------------

step "Проверка"

get_env() { grep -E "^\s*$1\s*=" "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs || true; }
SITE_PORT="$(get_env PORT)";        SITE_PORT="${SITE_PORT:-3101}"
ADMIN_PORT="$(get_env ADMIN_PORT)"; ADMIN_PORT="${ADMIN_PORT:-8080}"

health() {
  local url="$1" name="$2" i=0
  while [ "$i" -lt 25 ]; do
    curl -fsS -o /dev/null --max-time 5 "$url" && { info "$name отвечает"; return 0; }
    i=$((i + 1)); sleep 1
  done
  warn "$name не ответил: $url"
  return 1
}

ok=1
health "http://127.0.0.1:$ADMIN_PORT/api/v1/admin/auth/passkeys" "админка" || ok=0
health "http://127.0.0.1:$SITE_PORT/api/v1/cases/health"        "сайт"    || ok=0

step "Итог"
info "коммит: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
[ -n "$BACKUP_FILE" ] && info "копия базы: $BACKUP_FILE"

if [ "$ok" = 0 ]; then
  warn "один из сервисов не отвечает. Смотрите логи:"
  warn "  pm2 logs --lines 100"
  warn "Чаще всего причина одна: не заполнен .env, и процесс завершается сразу."
  exit 1
fi

printf '\n%sГотово. Дальше обновляйтесь так: ./deploy/update.sh%s\n' "$C_OK" "$C_OFF"
