#!/usr/bin/env bash
# 우분투 서버에 관제 서버를 설치하거나 업데이트한다. 다시 실행하면 코드만 갈아끼우고 재시작한다.
# 사용: sudo bash deploy/setup.sh cctv.example.com
# 네이버 클라우드 서버 만드는 법(서버 생성, ACG, 공인 IP): https://formjonghwa.tistory.com/entry/NCP-naver-cloud%EB%A5%BC-%ED%86%B5%ED%95%B4-%EA%B0%80%EC%9E%A5-%EC%89%BD%EA%B2%8C-%EC%84%9C%EB%B2%84-%EB%B0%B0%ED%8F%AC%ED%95%98%EB%8A%94-%EB%B0%A9%EB%B2%95-django-ubuntu-docker
# 자세한 순서는 DEPLOY.md
set -euo pipefail

DOMAIN="${1:?도메인을 인자로 주세요. 예: sudo bash deploy/setup.sh cctv.example.com}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/cctv
DATA=/var/lib/cctv

if [ "$(id -u)" -ne 0 ]; then echo "root 권한으로 실행하세요 (sudo)"; exit 1; fi

echo "== 패키지 설치"
apt-get update -q
apt-get install -y -q python3-venv curl gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v caddy >/dev/null; then
  echo "== Caddy(HTTPS 웹서버) 설치"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== 앱 복사"
id cctv >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin cctv
mkdir -p "$APP" "$DATA"
rm -rf "$APP/app" "$APP/static"
cp -r "$SRC/app" "$SRC/static" "$SRC/requirements.txt" "$APP/"
[ -d "$APP/.venv" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"
chown -R cctv:cctv "$DATA"

if [ ! -f /etc/cctv.env ]; then
  cat > /etc/cctv.env <<'ENVEOF'
# 관제 서버 선택 설정. 바꾼 뒤: systemctl restart cctv
# 텔레그램 알림 (README의 "텔레그램 알림 켜기" 참고)
#CCTV_TELEGRAM_TOKEN=123456:ABC...
#CCTV_TELEGRAM_CHAT_ID=-100123456789
ENVEOF
  chmod 600 /etc/cctv.env
fi

echo "== 서비스 등록"
cp "$SRC/deploy/cctv.service" /etc/systemd/system/cctv.service
sed "s/__DOMAIN__/$DOMAIN/" "$SRC/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable cctv caddy >/dev/null
systemctl restart cctv
systemctl restart caddy

sleep 3
echo
systemctl --no-pager --lines=0 status cctv | head -3
echo
if journalctl -u cctv --no-pager | grep -q "초기 관리자"; then
  journalctl -u cctv --no-pager | grep "초기 관리자" | tail -1
  echo "  ↑ 처음 로그인할 때 쓰고, 바로 비밀번호를 바꾸세요."
else
  echo "관리자 계정은 이미 있습니다 (기존 데이터 유지)."
fi
echo
echo "접속 주소: https://$DOMAIN"
echo "인증서 발급에 1분 정도 걸릴 수 있습니다. 안 되면: journalctl -u caddy -n 50"
