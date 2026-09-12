#!/usr/bin/env bash
# Fresh Debian 13 installation. Existing installations are never overwritten.
set -Eeuo pipefail
trap 'echo "Installation stopped at line $LINENO. Fix the error; existing data was not deleted." >&2' ERR
[[ $EUID == 0 ]] || { echo 'Run with sudo bash install.sh'; exit 1; }
DOMAIN=bearz.top
ADMIN_DOMAIN=admin.bearz.top
APP=/var/www/bearz
RUN_USER=bearz
REPO=https://github.com/KlachoW666/my-ru-r-a-s.git
EMAIL=${LE_EMAIL:-}
[[ -n $EMAIL ]] || { read -rp 'Email for TLS certificate notices: ' EMAIL; }
[[ $EMAIL == *@* && $EMAIL != -* ]] || { echo 'Valid email required'; exit 1; }
[[ ! -e $APP ]] || { echo "$APP exists. Installer is for a NEW installation only; no data changed."; exit 1; }
for domain in "$DOMAIN" "$ADMIN_DOMAIN"; do
  [[ ! -e /etc/nginx/sites-available/$domain && ! -e /etc/nginx/sites-enabled/$domain ]] || {
    echo "Existing nginx config for $domain; refusing to overwrite."; exit 1;
  }
done
. /etc/os-release
[[ $ID == debian && ${VERSION_ID%%.*} == 13 ]] || { echo 'This installer targets Debian 13.'; exit 1; }
echo 'DNS A/AAAA records for bearz.top and admin.bearz.top must point here; ports 80/443 must be reachable.'
apt-get update
apt-get install -y git curl ca-certificates nodejs npm nginx certbot python3-certbot-nginx build-essential python3 pkg-config sqlite3 openssl
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<20||(major===20&&minor<19)){console.error("Node >=20.19 required");process.exit(1)}'
command -v pm2 >/dev/null || npm install -g pm2@6
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/bearz --shell /bin/bash "$RUN_USER"
install -d -o "$RUN_USER" -g "$RUN_USER" "$APP"
runuser -u "$RUN_USER" -- git clone --branch main --single-branch "$REPO" "$APP"
cd "$APP"
[[ -f package-lock.json && -f admin.titanrust.ru/server/package-lock.json ]]
runuser -u "$RUN_USER" -- npm ci --omit=dev
runuser -u "$RUN_USER" -- npm ci --omit=dev --prefix admin.titanrust.ru/server
umask 077
SECRET=$(openssl rand -hex 48)
cat > "$APP/.env" <<EOF
NODE_ENV=production
PORT=3101
HOST=127.0.0.1
ADMIN_PORT=8080
PUBLIC_URL=https://$DOMAIN
ALLOWED_ORIGINS=https://$DOMAIN
COOKIE_DOMAIN=.$DOMAIN
JWT_SECRET=$SECRET
ALLOW_MOCK_AUTH=0
ADMIN_REQUIRE_AUTH=1
ADMIN_RP_ID=$ADMIN_DOMAIN
ADMIN_ORIGINS=https://$ADMIN_DOMAIN
STEAM_API_KEY=
STEAM_CATALOG_SYNC=0
EOF
unset SECRET
chown "$RUN_USER:$RUN_USER" "$APP/.env"
cat > "$APP/ecosystem.install.cjs" <<EOF
module.exports = {apps:[
 {name:'main-site',cwd:'$APP',script:'server.js',instances:1,exec_mode:'fork',env:{NODE_ENV:'production',HOST:'127.0.0.1',PORT:'3101'}},
 {name:'admin-panel',cwd:'$APP',script:'admin.titanrust.ru/server/server.js',instances:1,exec_mode:'fork',env:{NODE_ENV:'production',HOST:'127.0.0.1',ADMIN_PORT:'8080'}}
]};
EOF
chown "$RUN_USER:$RUN_USER" "$APP/ecosystem.install.cjs"
runuser -u "$RUN_USER" -- pm2 start "$APP/ecosystem.install.cjs" --only admin-panel
wait_http() {
  for attempt in {1..60}; do
    if curl -fsS "$1" -o /dev/null; then return; fi
    sleep 1
  done
  echo "No healthy response from $1. Inspect PM2 logs."; return 1
}
wait_http http://127.0.0.1:8080/
runuser -u "$RUN_USER" -- pm2 start "$APP/ecosystem.install.cjs" --only main-site
wait_http http://127.0.0.1:3101/
runuser -u "$RUN_USER" -- pm2 save
pm2 startup systemd -u "$RUN_USER" --hp /var/lib/bearz
umask 022
for pair in "$DOMAIN:3101" "$ADMIN_DOMAIN:8080"; do
  domain=${pair%:*}; port=${pair##*:}
  cat > "/etc/nginx/sites-available/$domain" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $domain;
  client_max_body_size 20m;
  add_header X-Content-Type-Options nosniff always;
  location / {
    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
EOF
  ln -s "/etc/nginx/sites-available/$domain" "/etc/nginx/sites-enabled/$domain"
done
nginx -t
systemctl enable --now nginx
systemctl reload nginx
echo 'Certbot will request a certificate and accept the Let’s Encrypt subscriber agreement.'
read -rp 'Accept and request HTTPS certificates? [yes/no]: ' ACCEPT
[[ $ACCEPT == yes ]] || { echo 'HTTP installed; HTTPS and passkey registration remain unfinished.'; exit 1; }
certbot --nginx --non-interactive --agree-tos --email "$EMAIL" --redirect -d "$DOMAIN" -d "$ADMIN_DOMAIN"
systemctl enable --now certbot.timer
curl -fsS "https://$DOMAIN/" -o /dev/null
curl -fsS "https://$ADMIN_DOMAIN/" -o /dev/null
echo 'Installed. Add Steam / SMTP / payment credentials to /var/www/bearz/.env before public launch.'
echo 'Create owner invite:'
echo "cd $APP && sudo -u $RUN_USER node deploy/make-invite.js --role SUPER_ADMIN --hours 2 --url https://$ADMIN_DOMAIN"
echo 'Restart after changing .env: sudo -u bearz pm2 restart all --update-env'
