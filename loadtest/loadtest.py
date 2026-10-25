"""부하 시험: 가짜 카메라 N대가 사진을 올리고, 가상 시청자 M명이 관제 화면처럼 받아 본다.

사용 예:
  python loadtest/loadtest.py https://cctv.example.com --user admin --viewers 500 --minutes 3

- 시험용 카메라("부하시험-1" ...)를 만들고, 끝나면 지운다.
- 시청자는 관리자 계정 세션 하나를 같이 쓴다 (로그인 부하는 따로 재지 않음).
- 이 PC의 인터넷 속도가 먼저 한계에 걸릴 수 있다. 정확히 재려면 같은 리전의 임시 VM에서 돌린다.
"""
import argparse
import asyncio
import getpass
import io
import random
import ssl
import statistics
import time

import aiohttp
from PIL import Image, ImageDraw

# 클라이언트마다 인증서 묶음을 새로 읽으면 수백 명일 때 이벤트 루프가 멈춘다. 하나를 같이 쓴다.
SSL_CTX = ssl.create_default_context()
TIMEOUT = aiohttp.ClientTimeout(total=20)


def session(base, cookies=None):
    """브라우저 한 대처럼 연결을 따로 쓰는 세션. IP 주소로 시험해도 쿠키를 받도록 unsafe 쿠키 저장소를 쓴다."""
    return aiohttp.ClientSession(base_url=base, cookies=cookies, timeout=TIMEOUT,
                                 cookie_jar=aiohttp.CookieJar(unsafe=True),
                                 connector=aiohttp.TCPConnector(ssl=SSL_CTX, limit=6),
                                 raise_for_status=True)


def make_jpeg(seed, w=1920, h=1080):
    """실제 도로 사진과 비슷한 크기(수백 KB)가 나오도록 도형 + 잡음을 섞은 JPEG."""
    rnd = random.Random(seed)
    im = Image.new("RGB", (w, h), (95, 110, 125))
    d = ImageDraw.Draw(im)
    for _ in range(500):
        x, y = rnd.randrange(w), rnd.randrange(h)
        c = tuple(rnd.randrange(256) for _ in range(3))
        d.rectangle([x, y, x + rnd.randrange(10, 140), y + rnd.randrange(10, 80)], fill=c)
    im = Image.blend(im, Image.effect_noise((w, h), 50).convert("RGB"), 0.2)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=72)
    return out.getvalue()


class Stats:
    def __init__(self):
        self.lat = {}
        self.bytes_in = 0
        self.errors = {}
        self.active = 0

    def ok(self, name, t0, nbytes=0):
        self.lat.setdefault(name, []).append(time.perf_counter() - t0)
        self.bytes_in += nbytes

    def err(self, name, e):
        key = f"{name}: {type(e).__name__} {getattr(e, 'status', '')}".strip()
        self.errors[key] = self.errors.get(key, 0) + 1

    def take(self):
        lat, self.lat = self.lat, {}
        b, self.bytes_in = self.bytes_in, 0
        return lat, b


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else 0


async def camera(base, key, interval, images, stats, stop):
    async with session(base) as c:
        i = 0
        while time.time() < stop:
            t0 = time.perf_counter()
            try:
                async with c.post("/api/cam/upload", data=images[i % len(images)],
                                  headers={"X-Camera-Key": key, "Content-Type": "image/jpeg"}) as r:
                    await r.read()
                stats.ok("업로드", t0)
            except Exception as e:
                stats.err("upload", e)
            i += 1
            await asyncio.sleep(interval)


async def viewer(base, cookies, start_delay, poll, wants_full, stats, stop):
    await asyncio.sleep(start_delay)
    seen = {}
    stats.active += 1
    async with session(base, cookies) as c:
        while time.time() < stop:
            t0 = time.perf_counter()
            try:
                async with c.get("/api/cameras") as r:
                    body = await r.read()
                    cams = (await r.json())["cameras"]
                stats.ok("목록", t0, len(body))

                async def fetch(cam, name, params):
                    t1 = time.perf_counter()
                    async with c.get(f"/api/snap/{cam['id']}", params=params) as r2:
                        stats.ok(name, t1, len(await r2.read()))

                # 브라우저처럼 새로 바뀐 사진들을 동시에 받는다
                jobs = []
                for cam in cams:
                    if cam["ts"] and seen.get(cam["id"]) != cam["ts"]:
                        seen[cam["id"]] = cam["ts"]
                        jobs.append(fetch(cam, "썸네일", {"size": "thumb", "t": str(cam["ts"])}))
                # 일부 시청자는 카메라 하나를 크게 보고 있다
                if wants_full and cams and cams[0]["ts"] and jobs:
                    jobs.append(fetch(cams[0], "원본", {"t": str(cams[0]["ts"])}))
                await asyncio.gather(*jobs)
            except Exception as e:
                stats.err("시청", e)
            await asyncio.sleep(poll)
    stats.active -= 1


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="서버 주소, 예: https://cctv.example.com")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", help="비우면 물어본다")
    ap.add_argument("--viewers", type=int, default=500)
    ap.add_argument("--cams", type=int, default=6)
    ap.add_argument("--interval", type=int, default=5, help="카메라 업로드 주기(초)")
    ap.add_argument("--minutes", type=float, default=3)
    ap.add_argument("--ramp", type=float, default=20, help="시청자가 모두 들어오는 데 걸리는 시간(초). 작을수록 순간 몰림")
    ap.add_argument("--full-ratio", type=float, default=0.1, help="원본을 크게 보는 시청자 비율")
    a = ap.parse_args()
    base = a.base.rstrip("/")
    pw = a.password or getpass.getpass(f"{a.user} 비밀번호: ")

    print("시험용 사진 만드는 중...")
    images = [make_jpeg(i) for i in range(3)]
    print(f"  사진 1장 약 {len(images[0]) // 1024}KB")

    async with session(base) as admin:
        async with admin.post("/api/login", json={"username": a.user, "password": pw}) as r:
            if (await r.json()).get("must_change"):
                raise SystemExit("이 계정은 비밀번호를 먼저 바꿔야 합니다. 웹에서 로그인해 바꾼 뒤 다시 실행하세요.")
        cookies = {m.key: m.value for m in admin.cookie_jar}

        cams = []
        try:
            for i in range(a.cams):
                async with admin.post("/api/admin/cameras", json={
                        "name": f"부하시험-{i + 1}", "location": "자동 삭제됨",
                        "interval_sec": a.interval, "sort": 900 + i}) as r:
                    cams.append(await r.json())
            print(f"시험용 카메라 {len(cams)}대 생성")

            stats = Stats()
            stop = time.time() + a.minutes * 60
            tasks = [asyncio.create_task(camera(base, c["key"], a.interval, images, stats, stop)) for c in cams]
            await asyncio.sleep(a.interval + 1)  # 첫 사진이 올라갈 때까지
            n_full = int(a.viewers * a.full_ratio)
            tasks += [asyncio.create_task(viewer(base, cookies, random.uniform(0, a.ramp), 3.0, i < n_full, stats, stop))
                      for i in range(a.viewers)]

            print(f"시청자 {a.viewers}명이 {a.ramp:.0f}초에 걸쳐 접속, {a.minutes}분 동안 시험\n")
            print(f"{'경과':>5} {'시청자':>6} {'요청/초':>7} {'수신 Mbps':>9}  응답시간 p50/p95 (ms)")
            all_lat, total_bytes, t_start, last = {}, 0, time.time(), time.time()
            while time.time() < stop:
                await asyncio.sleep(10)
                lat, b = stats.take()
                now = time.time()
                dt = now - last
                last = now
                total_bytes += b
                n = sum(len(v) for v in lat.values())
                parts = []
                for k, v in lat.items():
                    all_lat.setdefault(k, []).extend(v)
                    parts.append(f"{k} {pct(v, .5) * 1000:.0f}/{pct(v, .95) * 1000:.0f}")
                print(f"{now - t_start:>4.0f}s {stats.active:>6} {n / dt:>7.0f} {b * 8 / dt / 1e6:>9.1f}  " + ", ".join(parts))
            await asyncio.gather(*tasks, return_exceptions=True)

            secs = time.time() - t_start
            print("\n== 결과")
            for k, v in all_lat.items():
                print(f"  {k:4}: {len(v):>7}건  p50 {pct(v, .5) * 1000:.0f}ms  p95 {pct(v, .95) * 1000:.0f}ms  "
                      f"최대 {max(v) * 1000:.0f}ms  평균 {statistics.mean(v) * 1000:.0f}ms")
            print(f"  평균 수신 대역폭: {total_bytes * 8 / secs / 1e6:.1f} Mbps "
                  f"(시험 시간 동안 {total_bytes / 1e9:.2f} GB)")
            print(f"  → 2.5시간 운영 환산: 약 {total_bytes / secs * 9000 / 1e9:.0f} GB")
            if stats.errors:
                print("  오류:")
                for k, n in sorted(stats.errors.items(), key=lambda x: -x[1]):
                    print(f"    {k}: {n}건")
            else:
                print("  오류: 없음")
        finally:
            for c in cams:
                try:
                    async with admin.delete(f"/api/admin/cameras/{c['id']}"):
                        pass
                except Exception:
                    pass
            if cams:
                print(f"시험용 카메라 {len(cams)}대 삭제")


if __name__ == "__main__":
    asyncio.run(main())
