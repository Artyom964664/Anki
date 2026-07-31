#!/usr/bin/env bash
#
# Ставит приложение-карточки на свой сервер с автоматическим HTTPS (Caddy + Let's Encrypt).
# HTTPS обязателен: без него Android не предлагает установку и не работает офлайн-режим.
#
# Запуск от root:
#   curl -fsSL https://raw.githubusercontent.com/Artyom964664/Anki/main/deploy/vps-install.sh | bash
#
# Со своим доменом (предварительно направь его A-записью на этот сервер):
#   curl -fsSL .../vps-install.sh | bash -s english.example.com
#
# Обновить приложение потом: anki-update
#
set -euo pipefail

REPO="https://github.com/Artyom964664/Anki.git"
BRANCH="main"
DIR="/opt/anki"
DOMAIN="${1:-}"

say() { echo; echo "==> $*"; }
die() { echo; echo "!! $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "нужны права root — запусти через sudo"

# ---------- адрес ----------
if [ -z "$DOMAIN" ]; then
  IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  [ -n "$IP" ] || IP="$(hostname -I | awk '{print $1}')"
  [ -n "$IP" ] || die "не смог определить внешний IP — передай домен параметром"
  # nip.io превращает IP в имя, на которое можно выпустить сертификат
  DOMAIN="${IP}.nip.io"
fi
say "адрес сайта будет: https://${DOMAIN}"

# ---------- порты ----------
if command -v ss >/dev/null && ss -tln 2>/dev/null | grep -qE ':(80|443) '; then
  echo "!! порт 80 или 443 уже занят:"
  ss -tlnp 2>/dev/null | grep -E ':(80|443) ' || true
  die "останови текущий веб-сервер (например: systemctl stop nginx) и запусти скрипт снова"
fi

# ---------- зависимости ----------
say "устанавливаю зависимости"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq git curl ca-certificates gnupg apt-transport-https \
  debian-keyring debian-archive-keyring

# ---------- caddy ----------
if ! command -v caddy >/dev/null; then
  say "устанавливаю Caddy (он сам получит и будет продлевать сертификат)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -qq
  apt-get install -y -qq caddy
else
  say "Caddy уже установлен"
fi

# ---------- код приложения ----------
say "скачиваю приложение"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" reset --hard FETCH_HEAD
else
  rm -rf "$DIR"
  git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"
fi
[ -f "$DIR/app/index.html" ] || die "в репозитории нет app/index.html — что-то не так со скачиванием"

# ---------- конфиг ----------
say "настраиваю веб-сервер"
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	root * ${DIR}/app
	encode gzip
	file_server

	# Эти файлы решают, увидит ли телефон новую версию, поэтому их не кешируем.
	@nocache path /sw.js /index.html / /manifest.webmanifest
	header @nocache Cache-Control "no-cache"
}
EOF

systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy

# ---------- фаервол ----------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "открываю порты 80 и 443 в ufw"
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
fi

# ---------- команда обновления ----------
cat > /usr/local/bin/anki-update <<EOF
#!/usr/bin/env bash
set -e
git -C ${DIR} fetch --depth 1 origin ${BRANCH}
git -C ${DIR} reset --hard FETCH_HEAD
systemctl reload caddy 2>/dev/null || systemctl restart caddy
echo "приложение обновлено"
EOF
chmod +x /usr/local/bin/anki-update

# ---------- проверка ----------
say "проверяю, что сайт отвечает (сертификат выпускается 10-40 секунд)"
code="000"
for i in $(seq 1 12); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${DOMAIN}/" || echo 000)"
  [ "$code" = "200" ] && break
  sleep 5
done

echo
if [ "$code" = "200" ]; then
  echo "================================================================"
  echo " ГОТОВО. Открой на телефоне:  https://${DOMAIN}/"
  echo " Там: Chrome -> кнопка «Установить приложение» на главном экране."
  echo " Обновить приложение потом:   anki-update"
  echo "================================================================"
else
  echo "Сайт пока отвечает кодом ${code}. Что смотреть:"
  echo "  journalctl -u caddy -n 50 --no-pager"
  echo "Частые причины:"
  echo "  - порт 80 закрыт в фаерволе провайдера (Let's Encrypt не может проверить домен);"
  echo "  - лимит выдачи сертификатов на nip.io — тогда используй свой домен:"
  echo "      bash vps-install.sh мой-домен.ru"
fi
