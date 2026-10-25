#!/usr/bin/env bash
# macOS / Linux (윈도우 Git Bash도 가능): 처음이면 가상환경을 만들고, 서버를 켠다.
# 사용: ./run.sh            → http://localhost:8000
#       ./run.sh 8080       → 다른 포트
#       CCTV_ADMIN_PASSWORD='원하는비번' ./run.sh   → 처음 실행 때 관리자 비밀번호 지정
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8000}"

# 코드에 3.10+ 문법이 있다. 맥 기본 python3(3.9 등)는 건너뛰고 맞는 것을 찾는다.
find_python() {
  for c in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      echo "$c"; return
    fi
  done
  return 1
}

if [ -x .venv/bin/python ]; then PY=.venv/bin/python
elif [ -x .venv/Scripts/python.exe ]; then PY=.venv/Scripts/python.exe
else
  if BASE="$(find_python)"; then
    echo "== 가상환경 만드는 중 ($("$BASE" --version))"
    "$BASE" -m venv .venv
  else
    # 맞는 Python이 없으면 uv로 Python까지 받아서 만든다 (관리자 권한·Homebrew 불필요)
    UV="$(command -v uv || true)"
    [ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
    if [ -z "$UV" ]; then
      echo "Python 3.10 이상이 필요합니다. 아래 한 줄로 uv를 설치한 뒤 다시 실행하세요 (관리자 권한 불필요):"
      echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
      exit 1
    fi
    echo "== uv로 Python 3.12와 가상환경 만드는 중 (처음 한 번)"
    "$UV" venv --seed --python 3.12 .venv
  fi
  if [ -x .venv/bin/python ]; then PY=.venv/bin/python; else PY=.venv/Scripts/python.exe; fi
fi

# requirements.txt가 바뀌었을 때만 설치한다
STAMP=.venv/.requirements.sha
NEW="$("$PY" -c 'import hashlib; print(hashlib.sha256(open("requirements.txt","rb").read()).hexdigest())')"
if [ "$(cat "$STAMP" 2>/dev/null || true)" != "$NEW" ]; then
  echo "== 패키지 설치 중"
  "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q -r requirements.txt
  echo "$NEW" > "$STAMP"
fi

echo "== 서버 시작: http://localhost:$PORT   (끄려면 Ctrl+C)"
echo "   휴대폰 시험용 HTTPS 주소: 다른 터미널에서  cloudflared tunnel --url http://localhost:$PORT"
exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
