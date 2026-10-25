// 관제 화면: 카메라 목록을 주기적으로 받아 새 스냅샷만 다시 불러온다.
const POLL_MS = 3000;
const IDLE_MS = 30 * 60 * 1000; // 30분 무조작이면 갱신 중지 (전송량 절감)

const $ = id => document.getElementById(id);
const grid = $('grid');
const tiles = new Map(); // cam id -> { el, img, name, loc, age, cam, ts }
let cams = [];           // 서버가 준 전체 목록
let viewable = [];       // 지금 사진을 볼 수 있는 카메라 (크게 보기 넘기기 순서)
let skew = 0;            // 서버 시각 - 내 시각 (초)
let pollTimer = null;
let lastActivity = Date.now();
let lastOk = 0;
let failed = false;
let paused = false;
let operatingNow = true;
let lastBanners = '';
const isTouch = matchMedia('(pointer: coarse)').matches;
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 */ } },
};

const snapUrl = (c, thumb) => `/api/snap/${c.id}?${thumb ? 'size=thumb&' : ''}t=${c.ts}`;
const nowSec = () => Date.now() / 1000 + skew;

function swapImg(img, url) {
  const pre = new Image();
  pre.onload = () => { img.src = url; img.classList.add('loaded'); };
  pre.src = url;
}

// 사진이 얼마나 최근인지: 주기 안이면 초록, 늦어지면 노랑, 끊기면 빨강
function ageState(c, now) {
  if (!c.online) return 'off';
  return now - c.ts > c.interval * 2 + 5 ? 'late' : '';
}

// ---------------------------------------------------------------- 목록
function makeTile(c) {
  const el = document.createElement('button');
  el.className = 'cam';
  el.innerHTML = `<div class="shot"><img alt=""><div class="wait">불러오는 중</div></div>
    <div class="info"><div class="txt"><div class="name"></div><div class="loc"></div></div><span class="age"></span></div>`;
  el.addEventListener('click', () => openOverlay(c.id));
  return { el, img: el.querySelector('img'), name: el.querySelector('.name'),
           loc: el.querySelector('.loc'), age: el.querySelector('.age'), cam: c, ts: null };
}

function render(list) {
  cams = list;
  viewable = list.filter(c => c.online && c.ts);
  const ids = new Set(viewable.map(c => c.id));
  for (const [id, t] of tiles) if (!ids.has(id)) { t.el.remove(); tiles.delete(id); }
  grid.querySelector('.empty')?.remove();

  for (const c of viewable) {
    let t = tiles.get(c.id);
    if (!t) { t = makeTile(c); tiles.set(c.id, t); }
    grid.appendChild(t.el); // 순서 유지
    t.cam = c;
    t.name.textContent = c.name;
    t.loc.textContent = c.location;
    t.el.setAttribute('aria-label', `${c.name} 크게 보기`);
    if (c.ts !== t.ts) { t.ts = c.ts; swapImg(t.img, snapUrl(c, true)); }
  }

  if (!viewable.length) {
    const msg = !list.length ? '등록된 카메라가 없습니다.'
      : operatingNow ? '지금 송출 중인 카메라가 없습니다.' : '운영 시간이 되면 카메라 화면이 표시됩니다.';
    grid.insertAdjacentHTML('beforeend', `<p class="empty" style="grid-column:1/-1">${msg}</p>`);
  }

  // 연결 안 된 카메라는 아래에 작게 (운영 시간 밖에는 숨김)
  const off = operatingNow ? list.filter(c => !ids.has(c.id)) : [];
  $('offlineHead').hidden = !off.length;
  $('offlineTitle').textContent = `연결 안 된 카메라 ${off.length}`;
  const now = nowSec();
  $('offline').innerHTML = off.map(c => `<div class="off-row"><span class="dot bad"></span>
      <span><strong>${esc(c.name)}</strong> ${esc(c.location)}</span>
      <span class="sub">${c.ts ? `마지막 ${ago(now - c.ts)}` : '신호 없음'}</span></div>`).join('');

  $('summary').textContent = list.length ? `송출 중 ${viewable.length} / ${list.length}` : '카메라';
  updateAges();
  if (ovId != null) syncOverlay();
}

// 공지와 운영 시간 안내
function renderBanners(d) {
  let html = '';
  if (d.notice && d.notice.text) {
    const warn = d.notice.level === 'warn';
    html += `<div class="banner ${warn ? 'warn' : 'info'}" role="status">
      <strong>${warn ? '⚠ 주의' : '📢 공지'}</strong><span>${esc(d.notice.text)}</span></div>`;
  }
  if (d.operating && !d.operating.active) {
    html += `<div class="banner off"><strong>⏸</strong><span>${esc(d.operating.message)}</span></div>`;
  }
  if (html !== lastBanners) { $('banners').innerHTML = html; lastBanners = html; }
}

function updateAges() {
  const now = nowSec();
  for (const t of tiles.values()) {
    t.age.textContent = ago(now - t.cam.ts);
    t.age.className = 'age ' + ageState(t.cam, now);
  }
  if (ovId != null) {
    const c = cams.find(c => c.id === ovId);
    $('ovAge').textContent = c && c.ts ? `${ago(now - c.ts)} 촬영` : '신호 없음';
    $('ovAge').className = 'age ' + (c && c.ts ? ageState(c, now) : 'off');
  }
  // 상단 연결 상태
  const live = $('live');
  if (paused) {
    live.className = 'live'; $('liveText').textContent = '일시정지';
  } else if (failed) {
    live.className = 'live bad'; $('liveText').textContent = '연결 끊김';
  } else if (lastOk) {
    const since = (Date.now() - lastOk) / 1000;
    live.className = 'live ok';
    $('liveText').textContent = since < 10 ? '실시간' : `${ago(since)} 갱신`;
  }
}

async function refresh() {
  try {
    const d = await api('/api/cameras');
    skew = d.now - Date.now() / 1000;
    operatingNow = !d.operating || d.operating.active;
    renderBanners(d);
    render(d.cameras);
    lastOk = Date.now();
    failed = false;
  } catch (e) {
    failed = true;
  }
  updateAges();
}

function schedule() {
  clearTimeout(pollTimer);
  if (document.hidden || paused) return;
  pollTimer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !paused) refresh().then(schedule);
});

// 무조작 일시정지
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
  addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true });
}
setInterval(() => {
  updateAges();
  if (!paused && Date.now() - lastActivity > IDLE_MS) {
    paused = true; clearTimeout(pollTimer);
    $('idle').hidden = false;
  }
}, 1000);
$('resume').addEventListener('click', () => {
  paused = false; lastActivity = Date.now();
  $('idle').hidden = true;
  refresh().then(schedule);
});

// ---------------------------------------------------------------- 메뉴 / 보기 방식
$('menuBtn').addEventListener('click', e => {
  e.stopPropagation();
  const open = $('menu').hidden;
  $('menu').hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', open);
});
document.addEventListener('click', e => {
  if (!$('menu').hidden && !e.target.closest('.menu-wrap')) { $('menu').hidden = true; $('menuBtn').setAttribute('aria-expanded', false); }
});

function setCols(n) {
  grid.classList.toggle('one', n === '1');
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.cols === n));
  ls.set('cctv_cols', n);
}
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setCols(b.dataset.cols)));
setCols(ls.get('cctv_cols') || '2');

// ---------------------------------------------------------------- 크게 보기 + 디지털 줌
const ov = $('ov');
const stage = $('stage');
const ovImg = $('ovImg');
let ovId = null;
let ovTs = null;
const Z = { s: 1, x: 0, y: 0, bw: 0, bh: 0, swipe: 0 };
const MAX_ZOOM = 8;

$('hint').textContent = isTouch ? '두 손가락으로 확대 · 옆으로 밀어 넘기기' : '휠로 확대 · 드래그로 이동 · ←/→ 카메라 넘기기';

let hintTimer = null;
function openOverlay(id) {
  if (ovId == null) { // 처음 열 때만 사용법을 잠깐 보여준다
    $('hint').classList.remove('gone');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => $('hint').classList.add('gone'), 3500);
  }
  ovId = id; ovTs = null;
  Object.assign(Z, { s: 1, x: 0, y: 0, swipe: 0 });
  ovImg.removeAttribute('src');
  ov.hidden = false;
  syncOverlay();
}

function closeOverlay() { ov.hidden = true; ovId = null; }

function syncOverlay() {
  const c = cams.find(c => c.id === ovId);
  if (!c) { closeOverlay(); return; }
  $('ovTitle').textContent = c.name;
  $('ovLoc').textContent = c.location;
  const i = viewable.findIndex(v => v.id === c.id);
  $('ovCount').textContent = i >= 0 ? `${i + 1} / ${viewable.length}` : '';
  if (c.ts && c.ts !== ovTs) {
    ovTs = c.ts;
    const url = snapUrl(c);
    const pre = new Image();
    pre.onload = () => { if (ovId === c.id) ovImg.src = url; };
    pre.src = url;
  }
  updateAges();
}

function step(dir) {
  if (!viewable.length) return;
  const i = viewable.findIndex(c => c.id === ovId);
  openOverlay(viewable[(Math.max(i, 0) + dir + viewable.length) % viewable.length].id);
}

// 사진을 화면에 맞춘 기본 크기를 구하고, 확대 상태는 유지한다
function layout() {
  const r = stage.getBoundingClientRect();
  const iw = ovImg.naturalWidth || 16, ih = ovImg.naturalHeight || 9;
  const k = Math.min(r.width / iw, r.height / ih);
  const nbw = iw * k, nbh = ih * k;
  if (Z.bw && nbw !== Z.bw) { Z.x *= nbw / Z.bw; Z.y *= nbh / Z.bh; }
  Z.bw = nbw; Z.bh = nbh;
  ovImg.style.width = Z.bw + 'px';
  ovImg.style.height = Z.bh + 'px';
  clampZ(); applyZ();
}

function clampZ() {
  const r = stage.getBoundingClientRect();
  const w = Z.bw * Z.s, h = Z.bh * Z.s;
  Z.x = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, Z.x));
  Z.y = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, Z.y));
}

function applyZ() {
  ovImg.style.transform = `translate(${Z.x + Z.swipe}px, ${Z.y}px) scale(${Z.s})`;
  $('zoomLabel').textContent = Math.round(Z.s * 100) + '%';
  $('zReset').hidden = Z.s <= 1;
}

function zoomAt(f, px, py) {
  const ns = Math.min(MAX_ZOOM, Math.max(1, Z.s * f));
  Z.x = px - (px - Z.x) * (ns / Z.s);
  Z.y = py - (py - Z.y) * (ns / Z.s);
  Z.s = ns;
  clampZ(); applyZ();
}

function zoomCenter(f) {
  const r = stage.getBoundingClientRect();
  zoomAt(f, r.width / 2, r.height / 2);
}

function resetZoom() { Z.s = 1; clampZ(); applyZ(); }

ovImg.addEventListener('load', layout);
addEventListener('resize', () => { if (ovId != null) layout(); });

stage.addEventListener('wheel', e => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

stage.addEventListener('dblclick', e => {
  if (e.target.closest('.nav-btn')) return;
  const r = stage.getBoundingClientRect();
  if (Z.s > 1) resetZoom();
  else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top);
});

// 드래그 이동 + 두 손가락 핀치 + (확대 안 했을 때) 옆으로 밀어 넘기기
const ptrs = new Map();
let gLast = null;
let swipeStart = null;
function gesture() {
  const p = [...ptrs.values()];
  if (!p.length) return null;
  if (p.length === 1) return { n: 1, x: p[0].x, y: p[0].y };
  const [a, b] = p;
  return { n: 2, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.nav-btn')) return;
  try { stage.setPointerCapture(e.pointerId); } catch { /* 캡처 불가해도 제스처는 계속 */ }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gLast = gesture();
  swipeStart = ptrs.size === 1 && Z.s === 1 ? { x: e.clientX, y: e.clientY } : null;
});
stage.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = gesture();
  if (gLast && g && g.n === gLast.n) {
    const r = stage.getBoundingClientRect();
    if (g.n === 2) { swipeStart = null; zoomAt(g.d / gLast.d, g.x - r.left, g.y - r.top); }
    if (swipeStart && Z.s === 1) {
      Z.swipe = (g.x - swipeStart.x) * 0.6; // 넘기는 느낌만 살짝
    } else {
      Z.x += g.x - gLast.x; Z.y += g.y - gLast.y;
    }
    clampZ(); applyZ();
  }
  gLast = g;
});
for (const ev of ['pointerup', 'pointercancel']) {
  stage.addEventListener(ev, e => {
    if (swipeStart && ev === 'pointerup') {
      const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    }
    swipeStart = null;
    Z.swipe = 0; applyZ();
    ptrs.delete(e.pointerId);
    gLast = gesture();
  });
}

$('zIn').onclick = () => zoomCenter(1.5);
$('zOut').onclick = () => zoomCenter(1 / 1.5);
$('zReset').onclick = resetZoom;
$('close').onclick = closeOverlay;
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);

addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('menu').hidden) { $('menu').hidden = true; return; }
  if (ovId == null) return;
  if (e.key === 'Escape') closeOverlay();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === '+' || e.key === '=') zoomCenter(1.5);
  else if (e.key === '-') zoomCenter(1 / 1.5);
  else if (e.key === '0') resetZoom();
});

// ---------------------------------------------------------------- 시작
(async () => {
  try {
    const me = await api('/api/me');
    $('who').textContent = me.username;
    $('adminLink').hidden = !me.is_admin;
  } catch { /* api()가 로그인 페이지로 보냄 */ }
  await refresh();
  schedule();
})();
