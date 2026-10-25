# 네이버 클라우드 배포 가이드

전체 흐름: **서버 만들기 → 방화벽(ACG) 열기 → 공인 IP·도메인 연결 → 코드 올리기 → 설치 스크립트 실행**

> 📌 네이버 클라우드 콘솔에서 서버를 여는 과정은 화면 캡처와 함께 블로그에 정리해 두었다:
> [NCP(naver cloud)를 통해 가장 쉽게 서버 배포하는 방법](https://formjonghwa.tistory.com/entry/NCP-naver-cloud%EB%A5%BC-%ED%86%B5%ED%95%B4-%EA%B0%80%EC%9E%A5-%EC%89%BD%EA%B2%8C-%EC%84%9C%EB%B2%84-%EB%B0%B0%ED%8F%AC%ED%95%98%EB%8A%94-%EB%B0%A9%EB%B2%95-django-ubuntu-docker)
> 블로그는 Django + Docker 기준이지만, 서버 생성·ACG·공인 IP·접속 단계는 아래 1~3번과 같다.

## 1. 서버 만들기 (네이버 클라우드 콘솔)
**Services → Compute → Server → 서버 생성**

| 항목 | 선택 |
|---|---|
| 환경 | VPC |
| 이미지 | Ubuntu Server 24.04 (없으면 22.04) |
| 서버 타입 | Standard, **2vCPU / 4GB** 정도 |
| 스토리지 | 기본값(SSD 50GB)으로 충분 |
| 인증키 | 새로 생성 → `.pem` 파일을 안전한 곳에 보관 (다시 받을 수 없음) |
| 네트워크 접근 설정(ACG) | 아래 2번 참고 |

## 2. 방화벽(ACG) 규칙
**Server → ACG → 서버의 ACG 선택 → Inbound 규칙**

| 프로토콜 | 접근 소스 | 포트 | 용도 |
|---|---|---|---|
| TCP | **내 PC의 공인 IP**/32 | 22 | 관리용 SSH (전체 공개 금지) |
| TCP | 0.0.0.0/0 | 80 | HTTPS 인증서 발급용 |
| TCP | 0.0.0.0/0 | 443 | 서비스 (휴대폰, 직원 접속) |

내 PC 공인 IP는 네이버에서 "내 아이피"를 검색하면 나온다.

## 3. 공인 IP와 도메인
1. **Server → Public IP → 공인 IP 신청** → 만든 서버에 할당
2. 서버 접속 비밀번호: 서버 목록에서 서버 선택 → **서버 관리 및 설정 변경 → 관리자 비밀번호 확인** → `.pem` 파일 업로드
3. 도메인 (둘 중 하나)
   - **정식:** 보유한 도메인의 DNS에 A 레코드 추가 → 공인 IP. (예: `cctv.example.com → 223.130.x.x`)
   - **시범용 임시:** 도메인 없이 `공인IP.sslip.io`를 도메인으로 쓴다 (예: `223.130.1.2.sslip.io`).
     설정이 필요 없지만, 인증서 발급 한도에 걸리면 실패할 수 있으니 정식 운영에는 도메인을 쓴다.

## 4. 코드 올리기 (내 PC의 PowerShell)
```powershell
cd C:\Users\qorwh\OneDrive\Desktop\claude
tar -czf cctv.tgz --exclude=.venv --exclude=__pycache__ --exclude="cctv.db*" cctv
scp cctv.tgz root@공인IP:/root/
```
처음 접속할 때 "Are you sure you want to continue connecting?"가 나오면 `yes`, 비밀번호는 3-2에서 확인한 것.

## 5. 설치 (서버에서)
```powershell
ssh root@공인IP
```
접속한 뒤 서버에서:
```bash
tar xzf cctv.tgz && bash cctv/deploy/setup.sh 도메인
```
예: `bash cctv/deploy/setup.sh 223.130.1.2.sslip.io`

끝나면 **초기 관리자 비밀번호**가 출력된다. `https://도메인` 으로 접속해 로그인하고 바로 비밀번호를 바꾼다.

## 6. 코드 업데이트
4번(코드 올리기)을 다시 하고, 서버에서 같은 명령을 다시 실행한다. 계정과 카메라 데이터는 그대로 남는다.
```bash
rm -rf cctv && tar xzf cctv.tgz && bash cctv/deploy/setup.sh 도메인
```

## 7. 운영 중 자주 쓰는 명령 (서버에서)
| 하고 싶은 것 | 명령 |
|---|---|
| 상태 확인 | `systemctl status cctv` |
| 실시간 로그 | `journalctl -u cctv -f` |
| 재시작 | `systemctl restart cctv` |
| HTTPS 문제 확인 | `journalctl -u caddy -n 50` |
| 데이터 백업 | `cp /var/lib/cctv/cctv.db ~/cctv-backup-$(date +%F).db` |

## 8. 부하 시험 (배포 후 1회)
내 PC에서 실행하면 **PC 인터넷 속도가 먼저 한계**에 걸린다. 정확히 재려면 같은 리전에 작은 서버를 하나 더 만들어 거기서 돌리고, 끝나면 반납한다.
```bash
python3 -m venv lt && lt/bin/pip install -r cctv/loadtest/requirements.txt
lt/bin/python cctv/loadtest/loadtest.py https://도메인 --user admin --viewers 500 --minutes 3 --ramp 10
```
시험용 카메라는 자동으로 만들어지고 끝나면 지워진다. 관리자 비밀번호를 먼저 바꿔 둬야 한다.

**로컬 시험 결과 (2026-10-25, 같은 PC에서 서버와 시험 도구를 함께 실행):** 시청자 500명, 카메라 6대에서 오류 0건, 초당 약 730건 처리.
그때 수신량은 약 175Mbps였다. 2.5시간 동안 500명이 계속 보면 약 200GB에 해당한다.
시험용 사진은 잡음이 많아 실제 도로 사진보다 크므로, 실제 사용량은 이보다 적을 것이다.

## 9. 비용 메모
- 서버 요금 외에 **외부로 나가는 트래픽 요금**이 붙는다. 위 수치로 네이버 클라우드 요금표를 확인한다.
- 운영하지 않는 기간에는 서버를 정지할 수 있다. 정지 중에도 일부 요금(스토리지, 공인 IP)이 나갈 수 있으니 요금표를 확인한다.
