// 관제 화면: 카메라 목록을 주기적으로 받아 새 스냅샷만 다시 불러온다.
const POLL_MS = 3000;
const IDLE_MS = 30 * 60 * 1000; // 30분 무조작이면 갱신 중지 (전송량 절감)

const grid = document.getElementById('grid');
const tiles = new Map(); // cam id -> { el, img, name, loc, age, cam, ts }
let cams = [];
let skew = 0;            // 서버 시각 - 내 시각 (초)
let pollTimer = null;
let lastActivity = Date.now();
let paused = false;
let operatingNow = true;
let lastBanners = '';

const snapUrl = (c, thumb) => `/api/snap/${c.id}?${thumb ? 'size=thumb&' : ''}t=${c.ts}`;
const nowSec = () => Date.now() / 1000 + skew;

function swapImg(img, url) {
  const pre = new Image();
  pre.onload = () => { img.src = url; img.classList.add('loaded'); };
  pre.src = url;
}

function makeTile(c) {
  const el = document.createElement('button');
  el.className = 'tile';
  el.innerHTML = `<img alt=""><div class="wait">신호 대기 중</div>
    <span class="badge">오프라인</span>
    <div class="cap"><span class="name"></span><span class="loc"></span><span class="age"></span></div>`;
  el.addEventListener('click', () => openOverlay(c.id));
  return { el, img: el.querySelector('img'), name: el.querySelector('.name'),
           loc: el.querySelector('.loc'), age: el.querySelector('.age'), cam: c, ts: null };
}

function render(list) {
  cams = list;
  const ids = new Set(list.map(c => c.id));
  for (const [id, t] of tiles) if (!ids.has(id)) { t.el.remove(); tiles.delete(id); }
  grid.querySelector('.empty')?.remove();

  for (const c of list) {
    let t = tiles.get(c.id);
    if (!t) { t = makeTile(c); tiles.set(c.id, t); }
    grid.appendChild(t.el); // 순서 유지
    t.cam = c;
    t.name.textContent = c.name;
    t.loc.textContent = c.location;
    t.el.classList.toggle('offline', !c.online);
    if (c.ts && c.ts !== t.ts) { t.ts = c.ts; swapImg(t.img, snapUrl(c, true)); }
    if (!c.ts && t.ts) { t.ts = null; t.img.removeAttribute('src'); t.img.classList.remove('loaded'); }
    t.el.querySelector('.wait').textContent = operatingNow ? '신호 대기 중' : '운영 시간 아님';
  }
  if (!list.length) grid.insertAdjacentHTML('beforeend', '<p class="empty">등록된 카메라가 없습니다.</p>');
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
  if (html !== lastBanners) { document.getElementById('banners').innerHTML = html; lastBanners = html; }
}

function updateAges() {
  const now = nowSec();
  for (const t of tiles.values()) {
    t.age.textContent = t.cam.ts ? ago(now - t.cam.ts) : '';
  }
  if (ovId != null) {
    const c = cams.find(c => c.id === ovId);
    document.getElementById('ovAge').textContent =
      c ? (c.ts ? `${ago(nowSec() - c.ts)} 촬영` : '신호 대기 중') + (c.online ? '' : ' · 오프라인') : '';
  }
}

async function refresh() {
  try {
    const d = await api('/api/cameras');
    skew = d.now - Date.now() / 1000;
    operatingNow = !d.operating || d.operating.active;
    renderBanners(d);
    render(d.cameras);
    document.getElementById('conn').className = 'dot ok';
  } catch (e) {
    document.getElementById('conn').className = 'dot bad';
  }
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
    document.getElementById('idle').hidden = false;
  }
}, 1000);
document.getElementById('resume').addEventListener('click', () => {
  paused = false; lastActivity = Date.now();
  document.getElementById('idle').hidden = true;
  refresh().then(schedule);
});

// ---------------------------------------------------------------- 크게 보기 + 디지털 줌
const ov = document.getElementById('ov');
const stage = document.getElementById('stage');
const ovImg = document.getElementById('ovImg');
let ovId = null;
let ovTs = null;
const Z = { s: 1, x: 0, y: 0, bw: 0, bh: 0 };
const MAX_ZOOM = 8;

function openOverlay(id) {
  ovId = id; ovTs = null;
  Object.assign(Z, { s: 1, x: 0, y: 0 });
  ovImg.removeAttribute('src');
  ov.hidden = false;
  syncOverlay();
}

function closeOverlay() { ov.hidden = true; ovId = null; }

function syncOverlay() {
  const c = cams.find(c => c.id === ovId);
  if (!c) { closeOverlay(); return; }
  document.getElementById('ovTitle').textContent = c.location ? `${c.name} · ${c.location}` : c.name;
  if (c.ts && c.ts !== ovTs) {
    ovTs = c.ts;
    const url = snapUrl(c);
    const pre = new Image();
    pre.onload = () => { if (ovId === c.id) { ovImg.src = url; } };
    pre.src = url;
  }
  updateAges();
}

function step(dir) {
  if (!cams.length) return;
  const i = cams.findIndex(c => c.id === ovId);
  openOverlay(cams[(i + dir + cams.length) % cams.length].id);
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
  ovImg.style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
  document.getElementById('zoomLabel').textContent = Math.round(Z.s * 100) + '%';
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

ovImg.addEventListener('load', layout);
addEventListener('resize', () => { if (ovId != null) layout(); });

stage.addEventListener('wheel', e => {
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

stage.addEventListener('dblclick', e => {
  const r = stage.getBoundingClientRect();
  if (Z.s > 1) { Z.s = 1; clampZ(); applyZ(); }
  else zoomAt(2.5, e.clientX - r.left, e.clientY - r.top);
});

// 드래그 이동 + 두 손가락 핀치
const ptrs = new Map();
let gLast = null;
function gesture() {
  const p = [...ptrs.values()];
  if (!p.length) return null;
  if (p.length === 1) return { n: 1, x: p[0].x, y: p[0].y };
  const [a, b] = p;
  return { n: 2, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}
stage.addEventListener('pointerdown', e => {
  stage.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gLast = gesture();
  document.getElementById('hint').hidden = true;
});
stage.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = gesture();
  if (gLast && g && g.n === gLast.n) {
    const r = stage.getBoundingClientRect();
    if (g.n === 2) zoomAt(g.d / gLast.d, g.x - r.left, g.y - r.top);
    Z.x += g.x - gLast.x; Z.y += g.y - gLast.y;
    clampZ(); applyZ();
  }
  gLast = g;
});
for (const ev of ['pointerup', 'pointercancel']) {
  stage.addEventListener(ev, e => { ptrs.delete(e.pointerId); gLast = gesture(); });
}

document.getElementById('zIn').onclick = () => zoomCenter(1.5);
document.getElementById('zOut').onclick = () => zoomCenter(1 / 1.5);
document.getElementById('zReset').onclick = () => { Z.s = 1; clampZ(); applyZ(); };
document.getElementById('close').onclick = closeOverlay;
document.getElementById('prev').onclick = () => step(-1);
document.getElementById('next').onclick = () => step(1);

addEventListener('keydown', e => {
  if (ovId == null) return;
  if (e.key === 'Escape') closeOverlay();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === '+' || e.key === '=') zoomCenter(1.5);
  else if (e.key === '-') zoomCenter(1 / 1.5);
  else if (e.key === '0') { Z.s = 1; clampZ(); applyZ(); }
});

// ---------------------------------------------------------------- 시작
(async () => {
  try {
    const me = await api('/api/me');
    document.getElementById('who').textContent = me.username;
    document.getElementById('adminLink').hidden = !me.is_admin;
  } catch { /* api()가 로그인 페이지로 보냄 */ }
  await refresh();
  schedule();
})();
