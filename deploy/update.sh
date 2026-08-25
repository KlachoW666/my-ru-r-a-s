#!/usr/bin/env bash
#
# Обновление titanrust.ru и admin.titanrust.ru на сервере.
#
# Что делает по шагам:
#   1. проверяет, что окружение готово (git, node, .env);
#   2. делает копию базы — она не в git, восстановить её больше неоткуда;
#   3. забирает код из origin и переводит рабочее дерево на него;
#   4. доставляет зависимости в корне и в сервере админки;
#   5. перезапускает оба сервиса;
#   6. проверяет, что оба отвечают, и при неудаче откатывает код обратно.
#
# Запуск:
#   ./deploy/update.sh              обычное обновление
#   ./deploy/update.sh --dry-run    показать, что будет сделано, ничего не менять
#   ./deploy/update.sh --no-restart обновить файлы, не трогая сервисы
#   ./deploy/update.sh --branch dev обновиться на другую ветку
#
# Настройки можно переопределить в deploy/deploy.conf рядом со скриптом
# (файл не обязателен, см. deploy.conf.example).

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Расположение и настройки
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Значения по умолчанию. Любое переопределяется в deploy.conf или переменной
# окружения: BRANCH=dev ./deploy/update.sh
BRANCH="${BRANCH:-main}"
REMOTE="${REMOTE:-origin}"
SITE_SERVICE="${SITE_SERVICE:-titanrust}"
ADMIN_SERVICE="${ADMIN_SERVICE:-titanrust-admin}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
HEALTH_RETRIES="${HEALTH_RETRIES:-20}"
HEALTH_DELAY="${HEALTH_DELAY:-1}"

[ -f "$SCRIPT_DIR/deploy.conf" ] && . "$SCRIPT_DIR/deploy.conf"

DRY_RUN=0
DO_RESTART=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=1 ;;
    --no-restart) DO_RESTART=0 ;;
    --branch)     BRANCH="${2:?--branch требует имя ветки}"; shift ;;
    -h|--help)    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Вывод
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_ERR=''; C_WARN=''; C_DIM=''; C_OFF=''
fi

step() { printf '\n%s==>%s %s\n' "$C_OK" "$C_OFF" "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    %s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
die()  { printf '\n%sОшибка:%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }
run()  {
  if [ "$DRY_RUN" = 1 ]; then printf '    %s[dry-run]%s %s\n' "$C_DIM" "$C_OFF" "$*"; return 0; fi
  "$@"
}

# ---------------------------------------------------------------------------
# 1. Проверки перед началом
# ---------------------------------------------------------------------------

step "Проверка окружения"

cd "$APP_DIR"
info "каталог: $APP_DIR"

command -v git  >/dev/null 2>&1 || die "git не установлен"
command -v node >/dev/null 2>&1 || die "node не установлен"
command -v npm  >/dev/null 2>&1 || die "npm не установлен"

# rev-parse, а не «есть ли каталог .git»: в рабочем дереве git (git worktree)
# .git — это файл, и проверка по каталогу ложно срабатывала бы.
git rev-parse --git-dir >/dev/null 2>&1 || die "$APP_DIR — не git-репозиторий. Первый раз разворачивайте так:
    git clone <repo> $APP_DIR && cp .env.example .env && \$EDITOR .env"

# Без .env боевой сервер всё равно не поднимется: JWT_SECRET по умолчанию
# признан небезопасным, и при NODE_ENV=production процесс завершится сразу.
[ -f "$APP_DIR/.env" ] || die ".env не найден. Скопируйте .env.example в .env и заполните
    JWT_SECRET, STEAM_API_KEY, SMTP_*, ADMIN_* — иначе сервер не стартует."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "нужен Node 18+, установлен $(node -v)"
info "node $(node -v), npm $(npm -v)"

# Порты берём из .env, чтобы проверка здоровья стучалась туда же, куда слушает сервер.
get_env() { grep -E "^\s*$1\s*=" "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'\''' | xargs || true; }
SITE_PORT="$(get_env PORT)";        SITE_PORT="${SITE_PORT:-3101}"
ADMIN_PORT="$(get_env ADMIN_PORT)"; ADMIN_PORT="${ADMIN_PORT:-8080}"
info "порты: сайт $SITE_PORT, админка $ADMIN_PORT"

if [ "$(get_env ADMIN_REQUIRE_AUTH)" != "1" ]; then
  warn "ADMIN_REQUIRE_AUTH не равен 1 — админка пускает любой запрос без токена."
  warn "Заведите passkey и включите проверку до того, как откроете домен наружу."
fi

# ---------------------------------------------------------------------------
# 2. Как перезапускать сервисы
# ---------------------------------------------------------------------------

# sudo нужен только если мы не root. На части серверов sudo к тому же сломан
# («error initializing audit plugin sudoers_audit»), а под root он и не нужен.
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

# Имена процессов на серверах разные: где-то titanrust/titanrust-admin,
# где-то main-site/admin-panel. Если заданное имя не нашлось, перебираем
# привычные варианты, прежде чем сдаваться.
pm2_find() {
  local candidate
  for candidate in "$@"; do
    [ -z "$candidate" ] && continue
    if pm2 describe "$candidate" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

RESTART_KIND="none"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "^${SITE_SERVICE}\.service"; then
  RESTART_KIND="systemd"
elif command -v pm2 >/dev/null 2>&1; then
  # describe, а не pid: pid отвечает успехом и для несуществующего имени.
  FOUND_SITE="$(pm2_find "$SITE_SERVICE" main-site site titanrust kaban || true)"
  FOUND_ADMIN="$(pm2_find "$ADMIN_SERVICE" admin-panel admin titanrust-admin || true)"
  if [ -n "$FOUND_SITE" ] && [ -n "$FOUND_ADMIN" ]; then
    RESTART_KIND="pm2"
    [ "$FOUND_SITE" != "$SITE_SERVICE" ] && info "процесс сайта в pm2 называется «$FOUND_SITE»"
    [ "$FOUND_ADMIN" != "$ADMIN_SERVICE" ] && info "процесс админки в pm2 называется «$FOUND_ADMIN»"
    SITE_SERVICE="$FOUND_SITE"
    ADMIN_SERVICE="$FOUND_ADMIN"
  fi
fi

if [ "$DO_RESTART" = 1 ]; then
  case "$RESTART_KIND" in
    systemd) info "перезапуск через systemd: $SITE_SERVICE, $ADMIN_SERVICE" ;;
    pm2)     info "перезапуск через pm2: $SITE_SERVICE, $ADMIN_SERVICE" ;;
    none)
      warn "ни systemd-юнита «$SITE_SERVICE», ни процесса pm2 с именем «$SITE_SERVICE» не нашлось."
      warn "Код обновлю, но перезапускать будет нечего — сделайте это руками."
      if command -v pm2 >/dev/null 2>&1; then
        warn "pm2 установлен, но процессы называются иначе. Посмотрите «pm2 list» и"
        warn "пропишите настоящие имена в deploy/deploy.conf, например:"
        warn "  SITE_SERVICE=main-site"
        warn "  ADMIN_SERVICE=admin-panel"
      else
        warn "Готовые юниты лежат в deploy/systemd/, ставятся так:"
        warn "  cp deploy/systemd/*.service /etc/systemd/system/ && systemctl daemon-reload"
      fi
      DO_RESTART=0
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 3. Копия базы
# ---------------------------------------------------------------------------

step "Резервная копия базы"

DB_PATH="$APP_DIR/admin.titanrust.ru/server/database.sqlite"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/database-$STAMP.sqlite"

if [ -f "$DB_PATH" ]; then
  run mkdir -p "$BACKUP_DIR"
  # sqlite3 .backup корректно снимает копию с работающей базы; если утилиты
  # нет — обычное копирование. Оно безопасно, потому что сервисы мы
  # останавливаем следующим шагом, а до этого копия нужна «как есть».
  if command -v sqlite3 >/dev/null 2>&1; then
    run sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
  else
    run cp "$DB_PATH" "$BACKUP_FILE"
  fi
  info "$BACKUP_FILE"
  # Старые копии подчищаем, иначе диск кончится незаметно.
  if [ "$DRY_RUN" = 0 ] && [ -d "$BACKUP_DIR" ]; then
    ls -1t "$BACKUP_DIR"/database-*.sqlite 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old; do
      rm -f "$old"; info "удалена старая копия: $(basename "$old")"
    done
  fi
else
  warn "базы ещё нет — она создастся при первом запуске админки"
fi

# ---------------------------------------------------------------------------
# 4. Забираем код
# ---------------------------------------------------------------------------

step "Обновление кода"

PREV_COMMIT="$(git rev-parse HEAD)"
info "было: $PREV_COMMIT $(git log -1 --format=%s)"

run git fetch "$REMOTE" "$BRANCH" --tags
TARGET="$(git rev-parse "$REMOTE/$BRANCH" 2>/dev/null || echo "")"
[ -n "$TARGET" ] || die "не нашёл $REMOTE/$BRANCH"

if [ "$TARGET" = "$PREV_COMMIT" ]; then
  info "уже на свежем коммите, обновлять нечего"
else
  info "станет: $TARGET $(git log -1 --format=%s "$TARGET")"
  git log --oneline "$PREV_COMMIT..$TARGET" 2>/dev/null | sed 's/^/        /' || true
fi

# Незакоммиченные правки бывают двух совершенно разных сортов, и валить их в
# одну кучу нельзя.
#
# Первый сорт — хлам от прежнего устройства репозитория. Когда-то в git лежали
# node_modules и database.sqlite; потом их убрали из индекса, но на сервере,
# развёрнутом со старого коммита, они остались отслеживаемыми, а npm и
# работающее приложение их с тех пор изменили. Именно из-за этого git pull
# вставал с «Your local changes would be overwritten by merge» на полусотне
# файлов node_modules. Терять там нечего: в новом дереве этих путей нет вовсе.
#
# Второй сорт — правка в исходниках, то есть чья-то ручная заплатка. Её молча
# затирать нельзя.
DIRTY="$(git status --porcelain --untracked-files=no | awk '{ $1=""; sub(/^ +/, ""); print }')"
if [ -n "$DIRTY" ]; then
  # Отбрасываем всё, что в целевом коммите игнорируется или просто отсутствует.
  REAL_DIRTY=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *node_modules/*|*.sqlite) continue ;;
    esac
    REAL_DIRTY="$REAL_DIRTY$f"$'
'
  done <<EOF_DIRTY
$DIRTY
EOF_DIRTY

  if [ -n "$(printf '%s' "$REAL_DIRTY" | tr -d '[:space:]')" ]; then
    warn "в исходниках есть незакоммиченные правки:"
    printf '%s' "$REAL_DIRTY" | sed 's/^/        /'
    die "разберитесь с ними (git stash или git checkout -- <файл>) и запустите снова"
  fi

  COUNT="$(printf '%s
' "$DIRTY" | grep -c . || true)"
  info "в дереве $COUNT изменённых отслеживаемых файлов — все в node_modules или база"
  info "в новом коммите этих путей нет, поэтому расхождение просто снимается"
fi

# reset --hard, а не pull: на сервере правок быть не должно, а merge-конфликт
# посреди обновления — худшее, что может случиться. Untracked-файлы
# (загрузки через админку, база, .env) не трогаются: git clean мы не зовём.
run git reset --hard "$REMOTE/$BRANCH"

# На сервере со старого коммита база была отслеживаемой, и reset её удалил:
# в новом дереве такого файла нет. Возвращаем из копии, снятой выше.
if [ "$DRY_RUN" = 0 ] && [ -n "${BACKUP_FILE:-}" ] && [ -f "$BACKUP_FILE" ] && [ ! -f "$DB_PATH" ]; then
  cp "$BACKUP_FILE" "$DB_PATH"
  info "база возвращена из копии — reset удалил её как отслеживаемый файл"
  info "больше это не повторится: теперь она вне git"
fi

# ---------------------------------------------------------------------------
# 5. Останавливаем сервисы
# ---------------------------------------------------------------------------

svc() {
  local action="$1" name="$2"
  case "$RESTART_KIND" in
    systemd) run ${SUDO:+$SUDO} systemctl "$action" "$name" ;;
    pm2)     case "$action" in
               stop)    run pm2 stop "$name" ;;
               # --update-env: без него pm2 оставляет процессу переменные
               # окружения от прошлого запуска, включая старый NODE_ENV.
               start|restart) run pm2 restart "$name" --update-env ;;
             esac ;;
  esac
}

if [ "$DO_RESTART" = 1 ]; then
  step "Остановка сервисов"
  # Останавливаем до npm install: пересборка sqlite3 не должна идти под
  # работающим процессом, который держит нативный модуль открытым.
  svc stop "$ADMIN_SERVICE"
  svc stop "$SITE_SERVICE"
  info "остановлены"
fi

# ---------------------------------------------------------------------------
# 6. Зависимости
# ---------------------------------------------------------------------------

step "Зависимости"

npm_install() {
  local dir="$1"
  info "npm ci в $dir"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  # npm ci воспроизводит lock-файл точь-в-точь; если lock разошёлся с
  # package.json, ci упадёт — тогда откатываемся на install.
  ( cd "$dir" && ( npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund ) )
}

npm_install "$APP_DIR"
npm_install "$APP_DIR/admin.titanrust.ru/server"

# server.js игрового сайта берёт sqlite3 из node_modules админки — если их
# снести, отвалится вся живая выдача сайта. Проверяем, что модуль на месте.
if [ "$DRY_RUN" = 0 ] && [ ! -d "$APP_DIR/admin.titanrust.ru/server/node_modules/sqlite3" ]; then
  die "sqlite3 не установился в admin.titanrust.ru/server/node_modules — сайт без него не поднимется"
fi

# ---------------------------------------------------------------------------
# 7. Запуск и проверка
# ---------------------------------------------------------------------------

health() {
  local url="$1" name="$2" i=0
  while [ "$i" -lt "$HEALTH_RETRIES" ]; do
    if curl -fsS -o /dev/null --max-time 5 "$url"; then
      info "$name отвечает"
      return 0
    fi
    i=$((i + 1))
    sleep "$HEALTH_DELAY"
  done
  warn "$name не ответил за $((HEALTH_RETRIES * HEALTH_DELAY)) с ($url)"
  return 1
}

rollback() {
  printf '\n%sОткат на %s%s\n' "$C_WARN" "$PREV_COMMIT" "$C_OFF"
  git reset --hard "$PREV_COMMIT"
  ( cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true )
  ( cd "$APP_DIR/admin.titanrust.ru/server" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true )
  svc start "$ADMIN_SERVICE"
  svc start "$SITE_SERVICE"
  echo "Код возвращён на прежний коммит. База не трогалась, копия: $BACKUP_FILE"
  echo "Логи: journalctl -u $SITE_SERVICE -n 100 --no-pager"
}

if [ "$DO_RESTART" = 1 ]; then
  step "Запуск"
  svc start "$ADMIN_SERVICE"
  svc start "$SITE_SERVICE"

  if [ "$DRY_RUN" = 0 ]; then
    step "Проверка"
    ok=1
    health "http://127.0.0.1:$ADMIN_PORT/api/v1/admin/auth/passkeys" "админка" || ok=0
    health "http://127.0.0.1:$SITE_PORT/api/v1/cases/health"        "сайт"    || ok=0
    if [ "$ok" = 0 ]; then
      rollback
      exit 1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------

step "Готово"
info "коммит: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
[ -f "${BACKUP_FILE:-}" ] && info "копия базы: $BACKUP_FILE"
if [ "$DRY_RUN" = 1 ]; then
  printf '\n%sЭто был dry-run — ничего не изменено.%s\n' "$C_DIM" "$C_OFF"
fi
