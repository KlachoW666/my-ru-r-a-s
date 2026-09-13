#!/usr/bin/env bash
# Обновление установки install.sh: main-site + admin-panel, Debian/PM2.
# sudo bash update.sh [--app /var/www/bearz] [--dry-run]
# .env, SQLite, загрузки, nginx и сертификаты не заменяются.
set -Eeuo pipefail

protected_path() {
  case "$1" in
    .env|.env.local|.env.*.local|*.sqlite|*.sqlite-*|data/*|backups/*|public/uploads/*|admin.titanrust.ru/public/uploads/*|deploy/deploy.conf|ecosystem.install*.cjs) return 0 ;;
    *) return 1 ;;
  esac
}

# Функция целиком считывается Bash до выполнения: git может обновить сам файл.
main() {
  APP=/var/www/bearz
  DRY_RUN=0
  while (($#)); do
    case "$1" in
      --app) APP="${2:?Укажите каталог после --app}"; shift ;;
      --dry-run) DRY_RUN=1 ;;
      -h|--help) echo 'sudo bash update.sh [--app /var/www/bearz] [--dry-run]'; return ;;
      *) echo "Неизвестный аргумент: $1" >&2; return 2 ;;
    esac
    shift
  done
  die() { echo "Ошибка: $*" >&2; exit 1; }
  [[ -d "$APP" ]] || die "Нет каталога $APP. Для новой установки используйте install.sh."
  APP="$(cd "$APP" && pwd -P)"
  [[ "$APP" != / && "$APP" != "$HOME" && "$APP" != *"'"* && "$APP" != *$'\n'* ]] || die 'Небезопасный путь установки.'
  [[ -f "$APP/server.js" && -f "$APP/admin.titanrust.ru/server/server.js" && -f "$APP/.env" ]] || die 'Это не установленный проект BEARZ или отсутствует .env.'
  SCRIPT="$(readlink -f -- "${BASH_SOURCE[0]}")"
  OWNER="$(stat -c '%U' "$APP")"
  if [[ $EUID == 0 ]]; then
    [[ "$OWNER" != root && "$OWNER" != UNKNOWN ]] || die 'Каталог проекта должен принадлежать пользователю приложения (bearz), не root.'
    flags=(--app "$APP")
    [[ $DRY_RUN == 0 ]] || flags+=(--dry-run)
    exec runuser -u "$OWNER" -- bash "$SCRIPT" "${flags[@]}"
  fi
  [[ "$(id -un)" == "$OWNER" ]] || die "Запустите от root либо $OWNER, чтобы использовать правильный PM2."
  cd "$APP"
  for command in git node npm pm2 sqlite3 curl flock; do
    command -v "$command" >/dev/null || die "Не установлена команда $command."
  done
  [[ "$(git rev-parse --show-toplevel)" == "$APP" ]] || die 'Корень Git не совпадает с каталогом приложения.'
  [[ "$(git branch --show-current)" == main ]] || die 'Обновление разрешено только для main.'
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die 'Есть ручные изменения отслеживаемых файлов. Сохраните их перед обновлением; скрипт их не затрёт.'
  exec 9> "$(git rev-parse --git-path bearz-update.lock)"
  flock -n 9 || die 'Другое обновление уже выполняется.'
  umask 077

  # Не исполняем .env как shell и не печатаем ключи в вывод.
  PORTS="$(node -e '
    process.loadEnvFile(".env");
    const [major,minor]=process.versions.node.split(".").map(Number);
    if(major<20 || (major===20 && minor<19)) throw Error("Нужен Node >=20.19");
    if(process.env.NODE_ENV!=="production") throw Error("В .env нужен NODE_ENV=production");
    if(!process.env.JWT_SECRET || process.env.JWT_SECRET.length<32) throw Error("Проверьте JWT_SECRET в .env");
    const ports=[process.env.PORT||"3101",process.env.ADMIN_PORT||"8080"];
    if(!ports.every(p=>/^\d+$/.test(p)&&Number(p)>0&&Number(p)<65536)) throw Error("Неверные порты в .env");
    console.log(ports.join(" "));
  ')"
  read -r SITE_PORT ADMIN_PORT <<< "$PORTS"
  # jlist содержит окружение процессов; используем только пути, без вывода JSON.
  pm2 jlist | node -e '
    let raw=""; process.stdin.on("data",c=>raw+=c); process.stdin.on("end",()=>{
      const rows=JSON.parse(raw), root=process.cwd();
      for(const [name,file] of [["main-site","server.js"],["admin-panel","admin.titanrust.ru/server/server.js"]]) {
        const row=rows.find(r=>r.name===name);
        if(!row || row.pm2_env.pm_cwd!==root || row.pm2_env.pm_exec_path!==root+"/"+file) {
          console.error("Проверьте PM2-процесс и каталог: "+name); process.exit(1);
        }
      }
    });'

  export GIT_TERMINAL_PROMPT=0
  echo 'Получение origin/main…'
  git fetch --no-tags origin main
  PREVIOUS="$(git rev-parse HEAD)"
  TARGET="$(git rev-parse FETCH_HEAD)"
  git merge-base --is-ancestor "$PREVIOUS" "$TARGET" || die 'История main разошлась. Автоматическая перезапись запрещена.'
  # Проверяем оба дерева: миграция со старой отслеживаемой базой требует отдельной процедуры.
  for revision in "$PREVIOUS" "$TARGET"; do
    while IFS= read -r -d '' file; do
      case "$file" in .env|admin.titanrust.ru/server/database.sqlite) die "В $revision отслеживается $file. Обновление остановлено." ;; esac
    done < <(git ls-tree -rz --name-only "$revision")
  done
  while IFS= read -r -d '' file; do
    if protected_path "$file"; then die "Обновление пытается изменить рабочие данные: $file"; fi
  done < <(git diff --name-only --no-renames -z "$PREVIOUS" "$TARGET")
  echo "Версия: ${PREVIOUS:0:8} -> ${TARGET:0:8}"
  git diff --stat "$PREVIOUS" "$TARGET"
  if [[ $DRY_RUN == 1 ]]; then
    echo 'Проверка завершена: код, база и процессы не изменены. Обновлены только ссылки Git после fetch.'
    return
  fi

  mkdir -p "$APP/backups"
  BACKUP="$(mktemp -d "$APP/backups/update-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
  cp -p -- "$APP/.env" "$BACKUP/.env"
  printf '%s\n' "$PREVIOUS" > "$BACKUP/revision.txt"
  DB="$APP/admin.titanrust.ru/server/database.sqlite"
  [[ -f "$DB" ]] || die 'Рабочая SQLite-база отсутствует. Не запускаем новую пустую базу вместо неё.'
  backed_up=0
  for attempt in 1 2 3; do
    if sqlite3 -cmd '.timeout 10000' "$DB" ".backup '$BACKUP/database.partial.sqlite'"; then backed_up=1; break; fi
    sleep 2
  done
  [[ $backed_up == 1 ]] || die "Не удалось скопировать SQLite. Код не изменён. Каталог: $BACKUP"
  [[ "$(sqlite3 -readonly "$BACKUP/database.partial.sqlite" 'PRAGMA quick_check;')" == ok ]] || die 'Копия базы не прошла quick_check.'
  mv -- "$BACKUP/database.partial.sqlite" "$BACKUP/database.sqlite"
  echo "Резервная копия базы и .env: $BACKUP"

  STOPPED=0
  UPDATED=0
  failed() {
    local status=$?
    trap - ERR
    echo "Обновление прервано (код $status). Копия: $BACKUP; прежний коммит: $PREVIOUS" >&2
    if [[ $STOPPED == 1 && $UPDATED == 0 ]]; then
      pm2 restart admin-panel --update-env || true
      pm2 restart main-site --update-env || true
    fi
    echo 'База автоматически НЕ восстанавливается, чтобы не потерять новые данные.' >&2
    echo 'Проверьте: sudo -u bearz pm2 logs --lines 60 --nostream' >&2
    exit "$status"
  }
  trap failed ERR
  wait_http() {
    local address="$1"
    for attempt in {1..45}; do
      if curl --fail --silent --max-time 3 "$address" -o /dev/null; then return 0; fi
      sleep 1
    done
    echo "Сервис не отвечает: $address" >&2
    return 1
  }
  need_root=0; need_admin=0
  if [[ ! -d node_modules ]] || ! git diff --quiet "$PREVIOUS" "$TARGET" -- package.json package-lock.json; then need_root=1; fi
  if [[ ! -d admin.titanrust.ru/server/node_modules ]] || ! git diff --quiet "$PREVIOUS" "$TARGET" -- admin.titanrust.ru/server/package.json admin.titanrust.ru/server/package-lock.json; then need_admin=1; fi
  echo 'Короткая остановка сайта для обновления…'
  STOPPED=1
  pm2 stop main-site
  pm2 stop admin-panel
  git merge --ff-only "$TARGET"
  UPDATED=1
  if [[ $need_root == 1 ]]; then npm ci --omit=dev --no-audit --no-fund; fi
  if [[ $need_admin == 1 ]]; then npm ci --omit=dev --no-audit --no-fund --prefix admin.titanrust.ru/server; fi
  node --check server.js
  node --check admin.titanrust.ru/server/server.js
  pm2 restart admin-panel --update-env
  wait_http "http://127.0.0.1:$ADMIN_PORT/api/v1/admin/auth/invite/validate"
  pm2 restart main-site --update-env
  wait_http "http://127.0.0.1:$SITE_PORT/api/v1/cases/health"
  pm2 save
  STOPPED=0
  trap - ERR
  echo "Готово: $(git rev-parse --short HEAD). .env, база и загрузки сохранены."
  echo 'Обновите страницу админки Ctrl+Shift+R. Регистрация по приглашению теперь с паролем.'
  pm2 status
}

main "$@"
