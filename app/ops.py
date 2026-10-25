"""운영 기능: 운영 시간 계산, 카메라 이상 판정, 텔레그램 알림. DB와 무관한 순수 로직만 둔다."""
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))  # 한국은 서머타임이 없어서 고정 오프셋으로 충분
DAY_NAMES = "월화수목금토일"
LOW_BATTERY = 0.2

DEFAULT_SCHEDULE = {"mode": "always", "days": [0, 1, 2, 3, 4], "start": "17:00", "end": "20:00"}


def _minutes(hm: str) -> int:
    h, m = hm.split(":")
    return int(h) * 60 + int(m)


def validate_schedule(s: dict) -> dict:
    """잘못된 값이면 ValueError. mode: always(항상) / schedule(시간표) / off(중지)"""
    mode = s.get("mode")
    if mode not in ("always", "schedule", "off"):
        raise ValueError("운영 방식이 올바르지 않습니다")
    days = sorted({int(d) for d in s.get("days", [])})
    if any(d < 0 or d > 6 for d in days):
        raise ValueError("요일 값이 올바르지 않습니다")
    try:
        start, end = _minutes(s["start"]), _minutes(s["end"])
    except (KeyError, ValueError):
        raise ValueError("시간은 HH:MM 형식입니다")
    if not (0 <= start < 24 * 60 and 0 < end <= 24 * 60):
        raise ValueError("시간 범위가 올바르지 않습니다")
    if start >= end:
        raise ValueError("종료 시간은 시작 시간보다 늦어야 합니다 (자정을 넘기는 운영은 지원하지 않음)")
    if mode == "schedule" and not days:
        raise ValueError("운영 요일을 하나 이상 고르세요")
    return {"mode": mode, "days": days, "start": s["start"], "end": s["end"]}


def operating_status(sched: dict, now: float | None = None) -> dict:
    """지금 운영 중인지와 화면에 보여줄 안내 문구."""
    now = time.time() if now is None else now
    mode = sched["mode"]
    if mode == "always":
        return {"active": True, "message": "", "next_start": None, "ends_at": None}
    if mode == "off":
        return {"active": False, "message": "관리자가 운영을 중지했습니다.", "next_start": None, "ends_at": None}

    dt = datetime.fromtimestamp(now, KST)
    start, end = _minutes(sched["start"]), _minutes(sched["end"])
    mins = dt.hour * 60 + dt.minute
    midnight = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    if dt.weekday() in sched["days"] and start <= mins < end:
        return {"active": True, "message": "", "next_start": None,
                "ends_at": (midnight + timedelta(minutes=end)).timestamp()}

    for add in range(8):
        day = midnight + timedelta(days=add)
        if day.weekday() not in sched["days"]:
            continue
        st = day + timedelta(minutes=start)
        if st.timestamp() > now:
            when = "오늘" if add == 0 else "내일" if add == 1 else f"{DAY_NAMES[day.weekday()]}요일"
            return {"active": False, "next_start": st.timestamp(), "ends_at": None,
                    "message": f"운영 시간이 아닙니다. 다음 운영: {when} {sched['start']}~{sched['end']}"}
    return {"active": False, "message": "운영 요일이 지정되지 않았습니다.", "next_start": None, "ends_at": None}


def camera_problems(online: bool, battery: float | None, charging: bool | None) -> dict[str, str]:
    """카메라 하나의 이상 상태. {코드: 설명}. 비어 있으면 정상."""
    if not online:
        return {"offline": "신호 끊김"}
    out = {}
    if charging is False:
        out["unplugged"] = "충전 끊김"
    if battery is not None and battery < LOW_BATTERY and not charging:
        out["battery"] = f"배터리 부족 ({round(battery * 100)}%)"
    return out


def telegram_enabled() -> bool:
    return bool(os.environ.get("CCTV_TELEGRAM_TOKEN") and os.environ.get("CCTV_TELEGRAM_CHAT_ID"))


def send_telegram(text: str):
    """설정돼 있으면 텔레그램으로 보낸다. 실패해도 서버는 계속 돈다."""
    if not telegram_enabled():
        return
    token = os.environ["CCTV_TELEGRAM_TOKEN"]
    data = urllib.parse.urlencode({"chat_id": os.environ["CCTV_TELEGRAM_CHAT_ID"], "text": text}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=10).read()
    except Exception as e:
        print(f"[CCTV] 텔레그램 전송 실패: {e}", flush=True)


def kst_day(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, KST).strftime("%Y-%m-%d")


def kst_hm(ts: float) -> str:
    return datetime.fromtimestamp(ts, KST).strftime("%H:%M")
