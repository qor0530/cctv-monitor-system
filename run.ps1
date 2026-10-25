# Windows PowerShell: 처음이면 가상환경을 만들고, 서버를 켠다.
# 사용: .\run.ps1          → http://localhost:8000
#       .\run.ps1 8080     → 다른 포트
# 스크립트 실행이 막혀 있으면: powershell -ExecutionPolicy Bypass -File .\run.ps1
param([int]$Port = 8000)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$py = '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
  Write-Host '== 가상환경 만드는 중'
  python -m venv .venv
}

# requirements.txt가 바뀌었을 때만 설치한다
$stamp = '.venv\.requirements.sha'
$new = (Get-FileHash requirements.txt -Algorithm SHA256).Hash.ToLower()
$old = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { '' }
if ($old -ne $new) {
  Write-Host '== 패키지 설치 중'
  & $py -m pip install -q --upgrade pip
  & $py -m pip install -q -r requirements.txt
  Set-Content -Path $stamp -Value $new -Encoding ascii
}

Write-Host "== 서버 시작: http://localhost:$Port   (끄려면 Ctrl+C)"
Write-Host "   휴대폰 시험용 HTTPS 주소: 다른 터미널에서  cloudflared tunnel --url http://localhost:$Port"
& $py -m uvicorn app.main:app --host 127.0.0.1 --port $Port
