"""이동형 도로 관제 서버 — 휴대폰이 올린 스냅샷을 로그인한 사용자에게 보여준다."""
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import ops

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
DB_PATH = os.environ.get("CCTV_DB", str(ROOT / "cctv.db"))
SECURE_COOKIE = os.environ.get("CCTV_SECURE_COOKIE", "0") == "1"

COOKIE = "cctv_session"
SESSION_TTL = 12 * 3600
SESSION_CACHE_SEC = 30
OFFLINE_AFTER = 30
MAX_UPLOAD = 4 * 1024 * 1024
THUMB_SIZE = 640  # 분할 화면용 썸네일 긴 변 길이
PBKDF2_ITER = 100_000
USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")

# ---------------------------------------------------------------- DB

_db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
_db.row_factory = sqlite3.Row
_db.execute("PRAGMA journal_mode=WAL")
_db.executescript("""
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  last_login REAL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS cameras(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  interval_sec INTEGER NOT NULL DEFAULT 5,
  rotation INTEGER NOT NULL DEFAULT 0,
  key_hash TEXT UNIQUE NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  cam_id INTEGER,
  message TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS stats_minute(ts INTEGER PRIMARY KEY, viewers INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS daily_users(day TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(day, user_id));
CREATE TABLE IF NOT EXISTS cam_views(
  day TEXT NOT NULL, cam_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  PRIMARY KEY(day, cam_id, user_id));
""")
if "rotation" not in [r[1] for r in _db.execute("PRAGMA table_info(cameras)")]:
    _db.execute("ALTER TABLE cameras ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0")
_lock = threading.Lock()


def q(sql, args=(), one=False):
    with _lock:
        rows = _db.execute(sql, args).fetchall()
    if one:
        return rows[0] if rows else None
    return rows


def x(sql, args=()):
    with _lock:
        return _db.execute(sql, args).lastrowid


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def hash_pw(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITER)
    return f"pbkdf2${PBKDF2_ITER}${salt.hex()}${dk.hex()}"


def check_pw(pw: str, stored: str) -> bool:
    _, it, salt, dk = stored.split("$")
    got = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
    return hmac.compare_digest(got.hex(), dk)


_DUMMY_HASH = hash_pw(secrets.token_hex(8))  # 없는 아이디도 같은 시간이 걸리게


def get_setting(key, default):
    r = q("SELECT value FROM settings WHERE key=?", (key,), one=True)
    return r["value"] if r else default


def set_setting(key, value):
    x("INSERT INTO settings(key,value) VALUES(?,?) "
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


_force_pw_change = get_setting("force_pw_change", "1") == "1"


def _json_setting(key, default):
    try:
        return json.loads(get_setting(key, ""))
    except ValueError:
        return default


try:
    _schedule = ops.validate_schedule(_json_setting("schedule", ops.DEFAULT_SCHEDULE))
except ValueError:
    _schedule = dict(ops.DEFAULT_SCHEDULE)
_notice = _json_setting("notice", {"text": "", "level": "info", "updated_at": None})


def operating():
    return ops.operating_status(_schedule)


def log_event(kind, message, cam_id=None):
    x("INSERT INTO events(ts,kind,cam_id,message) VALUES(?,?,?,?)", (time.time(), kind, cam_id, message))


def bootstrap_admin():
    if q("SELECT 1 FROM users WHERE is_admin=1 LIMIT 1", one=True):
        return
    user = os.environ.get("CCTV_ADMIN_USER", "admin")
    pw = os.environ.get("CCTV_ADMIN_PASSWORD") or secrets.token_urlsafe(9)
    x("INSERT INTO users(username,pw_hash,is_admin,must_change,created_at) VALUES(?,?,1,1,?) "
      "ON CONFLICT(username) DO UPDATE SET is_admin=1, blocked=0, must_change=1, pw_hash=excluded.pw_hash",
      (user, hash_pw(pw), time.time()))
    print(f"\n[CCTV] 초기 관리자 계정  아이디: {user}  비밀번호: {pw}\n", flush=True)


bootstrap_admin()

# ---------------------------------------------------------------- 세션

_sess_cache: dict[str, tuple[dict, float]] = {}


def load_session(token):
    if not token:
        return None
    th, now = sha(token), time.time()
    hit = _sess_cache.get(th)
    if hit and now - hit[1] < SESSION_CACHE_SEC:
        return hit[0] if hit[0]["expires"] > now else None
    r = q("SELECT u.id, u.username, u.is_admin, u.blocked, u.must_change, s.expires "
          "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=?", (th,), one=True)
    if not r or r["blocked"] or r["expires"] < now:
        _sess_cache.pop(th, None)
        return None
    user = dict(r)
    _sess_cache[th] = (user, now)
    return user


def forget_cached(user_id):
    for k, (u, _) in list(_sess_cache.items()):
        if u["id"] == user_id:
            _sess_cache.pop(k, None)


def drop_sessions(user_id):
    x("DELETE FROM sessions WHERE user_id=?", (user_id,))
    forget_cached(user_id)


def needs_pw_change(u):
    return bool(u["must_change"]) and _force_pw_change


async def current_user(request: Request):
    u = load_session(request.cookies.get(COOKIE))
    if not u:
        raise HTTPException(401, "로그인이 필요합니다")
    return u


async def viewer(u=Depends(current_user)):
    if needs_pw_change(u):
        raise HTTPException(403, "비밀번호를 먼저 변경하세요")
    return u


async def admin(u=Depends(viewer)):
    if not u["is_admin"]:
        raise HTTPException(403, "관리자만 접근할 수 있습니다")
    return u


# 로그인 시도 제한. 사내 NAT 뒤에서는 모두 같은 IP라서 IP 한도는 넉넉하게 둔다.
_fails: dict[str, list[float]] = {}


def too_many(key, limit):
    now = time.time()
    recent = [t for t in _fails.get(key, []) if now - t < 300]
    _fails[key] = recent
    return len(recent) >= limit


def note_fail(*keys):
    for k in keys:
        _fails.setdefault(k, []).append(time.time())


# ---------------------------------------------------------------- 스냅샷 (메모리)

_snaps: dict[int, dict] = {}  # cam_id -> {img, thumb, ts, battery, charging}


def make_thumb(data: bytes):
    """분할 화면용 작은 사진. 실패하면 None (원본을 대신 보낸다)."""
    try:
        im = Image.open(BytesIO(data))
        im.draft("RGB", (THUMB_SIZE, THUMB_SIZE))  # JPEG를 축소 디코딩해서 빠르다
        im = im.convert("RGB")
        im.thumbnail((THUMB_SIZE, THUMB_SIZE))
        out = BytesIO()
        im.save(out, "JPEG", quality=70)
        return out.getvalue()
    except Exception:
        return None


def cam_status(r):
    s = _snaps.get(r["id"])
    ts = s["ts"] if s else None
    limit = max(OFFLINE_AFTER, 3 * r["interval_sec"])
    return {
        "id": r["id"], "name": r["name"], "location": r["location"],
        "interval": r["interval_sec"], "ts": ts,
        "online": bool(ts and time.time() - ts < limit),
    }


def camera_by_key(request: Request):
    key = request.headers.get("x-camera-key", "")
    r = q("SELECT * FROM cameras WHERE key_hash=?", (sha(key),), one=True) if key else None
    if not r:
        raise HTTPException(401, "유효하지 않은 카메라 키입니다")
    if not r["enabled"]:
        raise HTTPException(403, "비활성화된 카메라입니다")
    return r


def new_camera_key():
    return "cam_" + secrets.token_urlsafe(18)


def live_problems(r):
    """운영 중일 때 카메라의 현재 이상 상태."""
    if not operating()["active"]:
        return {}
    s = _snaps.get(r["id"]) or {}
    return ops.camera_problems(cam_status(r)["online"], s.get("battery"), s.get("charging"))


# ---------------------------------------------------------------- 접속 통계

PRESENCE_SEC = 15  # 시청 화면은 3초마다 목록을 부르므로, 15초 안에 부른 사람을 "접속 중"으로 본다
_last_seen: dict[int, float] = {}
_seen_today: set[tuple[str, int]] = set()
_viewed_today: set[tuple[str, int, int]] = set()


def note_viewer(user_id):
    now = time.time()
    _last_seen[user_id] = now
    key = (ops.kst_day(now), user_id)
    if key not in _seen_today:
        _seen_today.add(key)
        x("INSERT OR IGNORE INTO daily_users(day,user_id) VALUES(?,?)", key)


def note_view(cam_id, user_id):
    key = (ops.kst_day(), cam_id, user_id)
    if key not in _viewed_today:
        _viewed_today.add(key)
        x("INSERT OR IGNORE INTO cam_views(day,cam_id,user_id) VALUES(?,?,?)", key)


def current_viewers():
    now = time.time()
    return sum(1 for t in _last_seen.values() if now - t < PRESENCE_SEC)


def record_minute():
    now = time.time()
    x("INSERT OR REPLACE INTO stats_minute(ts,viewers) VALUES(?,?)", (int(now // 60 * 60), current_viewers()))
    x("DELETE FROM stats_minute WHERE ts < ?", (now - 31 * 86400,))
    x("DELETE FROM events WHERE ts < ?", (now - 90 * 86400,))
    today = ops.kst_day(now)
    for uid, t in list(_last_seen.items()):
        if now - t > 3600:
            _last_seen.pop(uid, None)
    _seen_today.difference_update({k for k in _seen_today if k[0] != today})
    _viewed_today.difference_update({k for k in _viewed_today if k[0] != today})


# ---------------------------------------------------------------- 카메라 이상 알림

ALERT_GRACE = int(os.environ.get("CCTV_ALERT_GRACE", "120"))  # 운영 시작 직후 휴대폰을 켜는 동안은 알리지 않는다
_alerts: dict[int, dict[str, str]] = {}      # cam_id -> {코드: 설명}
_alert_since: dict[tuple[int, str], float] = {}
_op_state = {"active": None, "since": time.time()}


def check_alerts():
    now = time.time()
    op = operating()
    msgs = []
    if op["active"] != _op_state["active"]:
        if _op_state["active"] is not None:
            text = "운영 시작" if op["active"] else "운영 종료"
            log_event("operating", text)
            msgs.append(("▶️ " if op["active"] else "⏹️ ") + text)
        _op_state.update(active=op["active"], since=now)
    if not op["active"] or now - _op_state["since"] < ALERT_GRACE:
        _alerts.clear()
        _alert_since.clear()
    else:
        rows = q("SELECT * FROM cameras WHERE enabled=1")
        names = {r["id"]: r["name"] for r in rows}
        current = {r["id"]: p for r in rows if (p := live_problems(r))}
        for cid, probs in current.items():
            for code, text in probs.items():
                if code not in _alerts.get(cid, {}):
                    _alert_since[(cid, code)] = now
                    log_event("alert", f"{names[cid]}: {text}", cid)
                    msgs.append(f"⚠️ {names[cid]}: {text}")
        for cid, probs in _alerts.items():
            for code, text in probs.items():
                if code not in current.get(cid, {}):
                    _alert_since.pop((cid, code), None)
                    if cid in names:
                        log_event("recover", f"{names[cid]}: {text} → 정상", cid)
                        msgs.append(f"✅ {names[cid]}: {text} 해결")
        _alerts.clear()
        _alerts.update(current)
    if msgs:
        ops.send_telegram("[도로 관제]\n" + "\n".join(msgs))


async def background():
    last_minute = 0.0
    while True:
        try:
            await asyncio.to_thread(check_alerts)
            if time.time() - last_minute >= 60:
                last_minute = time.time()
                await asyncio.to_thread(record_minute)
        except Exception as e:
            print(f"[CCTV] 백그라운드 작업 오류: {e!r}", flush=True)
        await asyncio.sleep(15)


@asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(background())
    yield
    task.cancel()


# ---------------------------------------------------------------- 앱

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(self), microphone=()"
    return resp


def page(name):
    return FileResponse(STATIC / name, headers={"Cache-Control": "no-store"})


@app.get("/")
def index(request: Request):
    u = load_session(request.cookies.get(COOKIE))
    if not u:
        return RedirectResponse("/login")
    if needs_pw_change(u):
        return RedirectResponse("/change-password")
    return page("viewer.html")


@app.get("/login")
def login_page():
    return page("login.html")


@app.get("/change-password")
def change_pw_page(request: Request):
    if not load_session(request.cookies.get(COOKIE)):
        return RedirectResponse("/login")
    return page("change-password.html")


@app.get("/admin")
def admin_page(request: Request):
    u = load_session(request.cookies.get(COOKIE))
    if not u or not u["is_admin"] or needs_pw_change(u):
        return RedirectResponse("/")
    return page("admin.html")


@app.get("/cam")
def cam_page():
    return page("cam.html")


# ---- 인증

class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response):
    uname = body.username.strip()
    ip = request.client.host if request.client else "?"
    if too_many("u:" + uname, 5) or too_many("ip:" + ip, 100):
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 5분 후 다시 시도하세요")
    r = q("SELECT * FROM users WHERE username=?", (uname,), one=True)
    if not check_pw(body.password, r["pw_hash"] if r else _DUMMY_HASH) or not r:
        note_fail("u:" + uname, "ip:" + ip)
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다")
    if r["blocked"]:
        raise HTTPException(403, "차단된 계정입니다. 관리자에게 문의하세요")
    now = time.time()
    token = secrets.token_urlsafe(32)
    x("DELETE FROM sessions WHERE expires < ?", (now,))
    x("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)", (sha(token), r["id"], now + SESSION_TTL))
    x("UPDATE users SET last_login=? WHERE id=?", (now, r["id"]))
    response.set_cookie(COOKIE, token, max_age=SESSION_TTL, httponly=True,
                        samesite="lax", secure=SECURE_COOKIE)
    return {"must_change": needs_pw_change(r), "is_admin": bool(r["is_admin"])}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        x("DELETE FROM sessions WHERE token=?", (sha(token),))
        _sess_cache.pop(sha(token), None)
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(u=Depends(current_user)):
    return {"username": u["username"], "is_admin": bool(u["is_admin"]),
            "must_change": needs_pw_change(u)}


class PwIn(BaseModel):
    old: str
    new: str


@app.post("/api/change-password")
def change_password(body: PwIn, u=Depends(current_user)):
    r = q("SELECT pw_hash FROM users WHERE id=?", (u["id"],), one=True)
    if not check_pw(body.old, r["pw_hash"]):
        raise HTTPException(400, "현재 비밀번호가 올바르지 않습니다")
    if len(body.new) < 8:
        raise HTTPException(400, "새 비밀번호는 8자 이상이어야 합니다")
    if body.new == u["username"] or body.new == body.old:
        raise HTTPException(400, "사번이나 기존 비밀번호와 다른 비밀번호를 쓰세요")
    x("UPDATE users SET pw_hash=?, must_change=0 WHERE id=?", (hash_pw(body.new), u["id"]))
    forget_cached(u["id"])
    return {"ok": True}


# ---- 관제

_enabled_cams = (0.0, [])  # (조회 시각, rows) — 시청자 수백 명이 3초마다 부르므로 1초간 재사용


@app.get("/api/cameras")
async def cameras(u=Depends(viewer)):
    global _enabled_cams
    note_viewer(u["id"])
    if time.time() - _enabled_cams[0] > 1:
        _enabled_cams = (time.time(), q("SELECT * FROM cameras WHERE enabled=1 ORDER BY sort, id"))
    op = operating()
    cams = [cam_status(r) for r in _enabled_cams[1]]
    if not op["active"]:
        for c in cams:  # 운영 시간 밖에는 지난 사진을 보여주지 않는다
            c.update(ts=None, online=False)
    out = {"now": time.time(), "cameras": cams, "operating": op}
    if _notice.get("text"):
        out["notice"] = _notice
    return out


@app.get("/api/snap/{cam_id}")
async def snap(cam_id: int, size: str = "full", u=Depends(viewer)):
    s = _snaps.get(cam_id)
    if not s:
        raise HTTPException(404, "영상이 아직 없습니다")
    if size == "thumb" and s["thumb"]:
        img = s["thumb"]
    else:
        img = s["img"]
        note_view(cam_id, u["id"])
    # 주소에 촬영 시각(?t=)이 붙어서 바뀌므로 브라우저 캐시를 써도 된다
    return Response(img, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=300"})


# ---- 송출 (카메라 키 인증)

def cam_reply(cam):
    op = operating()
    return {"name": cam["name"], "interval": cam["interval_sec"], "rotation": cam["rotation"],
            "active": op["active"], "message": op["message"]}


@app.get("/api/cam/config")
def cam_config(request: Request):
    return cam_reply(camera_by_key(request))


@app.post("/api/cam/upload")
async def cam_upload(request: Request):
    cam = camera_by_key(request)
    reply = cam_reply(cam)
    if not reply["active"]:
        return reply  # 운영 시간 밖: 받지 않고 대기하라고 알려준다
    if int(request.headers.get("content-length") or 0) > MAX_UPLOAD:
        raise HTTPException(413, "사진이 너무 큽니다")
    data = await request.body()
    if len(data) > MAX_UPLOAD or not data.startswith(b"\xff\xd8\xff"):
        raise HTTPException(400, "JPEG 사진만 받을 수 있습니다")
    try:
        battery = float(request.headers.get("x-battery", ""))
    except ValueError:
        battery = None
    thumb = await run_in_threadpool(make_thumb, data)
    _snaps[cam["id"]] = {
        "img": data, "thumb": thumb, "ts": time.time(), "battery": battery,
        "charging": {"1": True, "0": False}.get(request.headers.get("x-charging", "")),
    }
    return reply


# ---- 관리자: 카메라

class CamIn(BaseModel):
    name: str
    location: str = ""
    interval_sec: int = 5
    rotation: int = 0
    sort: int = 0


class CamPatch(BaseModel):
    name: str | None = None
    location: str | None = None
    interval_sec: int | None = None
    rotation: int | None = None
    enabled: bool | None = None
    sort: int | None = None


def check_cam_fields(name=None, location=None, interval=None, rotation=None):
    if name is not None and not 1 <= len(name.strip()) <= 40:
        raise HTTPException(400, "카메라 이름은 1~40자입니다")
    if location is not None and len(location) > 100:
        raise HTTPException(400, "위치는 100자 이하입니다")
    if interval is not None and not 2 <= interval <= 60:
        raise HTTPException(400, "갱신 주기는 2~60초입니다")
    if rotation is not None and rotation not in (0, 90, 180, 270):
        raise HTTPException(400, "회전은 0, 90, 180, 270도 중 하나입니다")


@app.get("/api/admin/cameras")
def admin_cameras(a=Depends(admin)):
    out = []
    for r in q("SELECT * FROM cameras ORDER BY sort, id"):
        s = _snaps.get(r["id"]) or {}
        out.append({**cam_status(r), "enabled": bool(r["enabled"]), "sort": r["sort"],
                    "rotation": r["rotation"], "problems": live_problems(r),
                    "battery": s.get("battery"), "charging": s.get("charging")})
    return {"now": time.time(), "cameras": out}


@app.post("/api/admin/cameras")
def admin_add_camera(body: CamIn, a=Depends(admin)):
    check_cam_fields(body.name, body.location, body.interval_sec, body.rotation)
    if q("SELECT COUNT(*) AS n FROM cameras", one=True)["n"] >= 20:
        raise HTTPException(400, "카메라는 최대 20대까지 등록할 수 있습니다")
    key = new_camera_key()
    cid = x("INSERT INTO cameras(name,location,interval_sec,rotation,sort,key_hash,created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (body.name.strip(), body.location.strip(), body.interval_sec, body.rotation, body.sort,
             sha(key), time.time()))
    return {"id": cid, "key": key}


@app.patch("/api/admin/cameras/{cam_id}")
def admin_edit_camera(cam_id: int, body: CamPatch, a=Depends(admin)):
    check_cam_fields(body.name, body.location, body.interval_sec, body.rotation)
    fields = body.model_dump(exclude_none=True)
    if not fields:
        return {"ok": True}
    if "name" in fields:
        fields["name"] = fields["name"].strip()
    sets = ", ".join(f"{k}=?" for k in fields)
    x(f"UPDATE cameras SET {sets} WHERE id=?", (*fields.values(), cam_id))
    if fields.get("enabled") is False:
        _snaps.pop(cam_id, None)
    return {"ok": True}


@app.post("/api/admin/cameras/{cam_id}/rotate-key")
def admin_rotate_key(cam_id: int, a=Depends(admin)):
    key = new_camera_key()
    x("UPDATE cameras SET key_hash=? WHERE id=?", (sha(key), cam_id))
    _snaps.pop(cam_id, None)
    return {"key": key}


@app.delete("/api/admin/cameras/{cam_id}")
def admin_delete_camera(cam_id: int, a=Depends(admin)):
    x("DELETE FROM cameras WHERE id=?", (cam_id,))
    _snaps.pop(cam_id, None)
    return {"ok": True}


# ---- 관리자: 계정

class BulkIn(BaseModel):
    usernames: list[str]


class UserPatch(BaseModel):
    blocked: bool | None = None
    is_admin: bool | None = None


@app.get("/api/admin/users")
def admin_users(a=Depends(admin)):
    rows = q("SELECT id, username, is_admin, blocked, must_change, created_at, last_login "
             "FROM users ORDER BY username")
    return {"users": [dict(r) for r in rows]}


@app.post("/api/admin/users/bulk")
def admin_bulk_users(body: BulkIn, a=Depends(admin)):
    if len(body.usernames) > 1000:
        raise HTTPException(400, "한 번에 1000명까지 만들 수 있습니다")
    created, existing, invalid, seen = [], [], [], set()
    for raw in body.usernames:
        name = raw.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        if not USERNAME_RE.match(name):
            invalid.append(name)
        elif q("SELECT 1 FROM users WHERE username=?", (name,), one=True):
            existing.append(name)
        else:
            x("INSERT INTO users(username,pw_hash,created_at) VALUES(?,?,?)",
              (name, hash_pw(name), time.time()))
            created.append(name)
    return {"created": created, "existing": existing, "invalid": invalid}


def target_user(user_id, a):
    r = q("SELECT * FROM users WHERE id=?", (user_id,), one=True)
    if not r:
        raise HTTPException(404, "없는 계정입니다")
    if r["id"] == a["id"]:
        raise HTTPException(400, "자기 계정은 여기서 바꿀 수 없습니다")
    return r


@app.patch("/api/admin/users/{user_id}")
def admin_edit_user(user_id: int, body: UserPatch, a=Depends(admin)):
    target_user(user_id, a)
    if body.blocked is not None:
        x("UPDATE users SET blocked=? WHERE id=?", (int(body.blocked), user_id))
        if body.blocked:
            drop_sessions(user_id)
    if body.is_admin is not None:
        x("UPDATE users SET is_admin=? WHERE id=?", (int(body.is_admin), user_id))
        forget_cached(user_id)
    return {"ok": True}


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: int, a=Depends(admin)):
    r = target_user(user_id, a)
    x("UPDATE users SET pw_hash=?, must_change=1 WHERE id=?", (hash_pw(r["username"]), user_id))
    drop_sessions(user_id)
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: int, a=Depends(admin)):
    target_user(user_id, a)
    drop_sessions(user_id)
    x("DELETE FROM users WHERE id=?", (user_id,))
    return {"ok": True}


# ---- 관리자: 설정

class SettingsIn(BaseModel):
    force_pw_change: bool


@app.get("/api/admin/settings")
def admin_get_settings(a=Depends(admin)):
    return {"force_pw_change": _force_pw_change, "telegram": ops.telegram_enabled()}


@app.put("/api/admin/settings")
def admin_put_settings(body: SettingsIn, a=Depends(admin)):
    global _force_pw_change
    _force_pw_change = body.force_pw_change
    set_setting("force_pw_change", "1" if body.force_pw_change else "0")
    return {"ok": True}


# ---- 관리자: 운영 시간, 공지

class ScheduleIn(BaseModel):
    mode: str
    days: list[int] = []
    start: str = "17:00"
    end: str = "20:00"


class NoticeIn(BaseModel):
    text: str = ""
    level: str = "info"


@app.get("/api/admin/operation")
def admin_get_operation(a=Depends(admin)):
    return {"schedule": _schedule, "status": operating(), "notice": _notice}


@app.put("/api/admin/schedule")
def admin_put_schedule(body: ScheduleIn, a=Depends(admin)):
    global _schedule
    try:
        sched = ops.validate_schedule(body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))
    _schedule = sched
    set_setting("schedule", json.dumps(sched))
    days = "".join(ops.DAY_NAMES[d] for d in sched["days"])
    label = {"always": "항상 운영", "off": "운영 중지",
             "schedule": f"시간표 {days} {sched['start']}~{sched['end']}"}[sched["mode"]]
    log_event("admin", f"{a['username']}: 운영 방식 변경 → {label}")
    return {"schedule": _schedule, "status": operating()}


@app.put("/api/admin/notice")
def admin_put_notice(body: NoticeIn, a=Depends(admin)):
    global _notice
    text = body.text.strip()
    if len(text) > 200:
        raise HTTPException(400, "공지는 200자 이하입니다")
    if body.level not in ("info", "warn"):
        raise HTTPException(400, "공지 종류가 올바르지 않습니다")
    _notice = {"text": text, "level": body.level, "updated_at": time.time() if text else None}
    set_setting("notice", json.dumps(_notice))
    log_event("admin", f"{a['username']}: " + (f"공지 게시 - {text}" if text else "공지 내림"))
    return _notice


# ---- 관리자: 알림, 통계

@app.get("/api/admin/alerts")
def admin_alerts(a=Depends(admin)):
    names = {r["id"]: r["name"] for r in q("SELECT id, name FROM cameras")}
    active = [{"cam_id": cid, "name": names.get(cid, "?"), "code": code, "message": text,
               "since": _alert_since.get((cid, code))}
              for cid, probs in _alerts.items() for code, text in probs.items()]
    events = [dict(r) for r in q("SELECT ts, kind, message FROM events ORDER BY id DESC LIMIT 50")]
    return {"now": time.time(), "active": active, "events": events}


@app.get("/api/admin/stats")
def admin_stats(a=Depends(admin)):
    now = time.time()
    today = ops.kst_day(now)
    midnight = now - (now + 9 * 3600) % 86400  # 오늘 0시 (한국 시간)
    series = [[r["ts"], r["viewers"]] for r in
              q("SELECT ts, viewers FROM stats_minute WHERE ts >= ? ORDER BY ts", (now - 24 * 3600,))]
    peak = q("SELECT ts, viewers FROM stats_minute WHERE ts >= ? ORDER BY viewers DESC, ts LIMIT 1",
             (midnight,), one=True)
    unique = q("SELECT COUNT(*) AS n FROM daily_users WHERE day=?", (today,), one=True)["n"]
    cam_views = [dict(r) for r in q(
        "SELECT c.name, COUNT(v.user_id) AS viewers FROM cameras c "
        "LEFT JOIN cam_views v ON v.cam_id = c.id AND v.day = ? GROUP BY c.id ORDER BY c.sort, c.id",
        (today,))]
    uniq_by_day = {r["day"]: r["n"] for r in q(
        "SELECT day, COUNT(*) AS n FROM daily_users WHERE day >= ? GROUP BY day",
        (ops.kst_day(now - 6 * 86400),))}
    peak_by_day = {r["day"]: r["peak"] for r in q(
        "SELECT date(ts + 32400, 'unixepoch') AS day, MAX(viewers) AS peak FROM stats_minute "
        "WHERE ts >= ? GROUP BY day", (midnight - 6 * 86400,))}
    days = [{"day": d, "unique": uniq_by_day.get(d, 0), "peak": peak_by_day.get(d, 0)}
            for d in (ops.kst_day(now - i * 86400) for i in range(6, -1, -1))]
    return {
        "now": now,
        "viewers_now": current_viewers(),
        "today": {"unique": unique,
                  "peak": peak["viewers"] if peak else 0,
                  "peak_at": peak["ts"] if peak and peak["viewers"] else None},
        "series": series,
        "cam_views": cam_views,
        "days": days,
    }


app.mount("/static", StaticFiles(directory=STATIC), name="static")
