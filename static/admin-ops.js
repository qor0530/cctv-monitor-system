// 관리자 화면: 이상 알림 막대, 운영 시간, 공지, 알림 기록, 접속 통계
const DAY_NAMES = '월화수목금토일';
const KST = { timeZone: 'Asia/Seoul' };
const fmtTime = ts => new Date(ts * 1000).toLocaleTimeString('ko-KR', { ...KST, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDateTime = ts => new Date(ts * 1000).toLocaleString('ko-KR',
  { ...KST, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 */ } };

// ---------------------------------------------------------------- 이상 알림 막대 (모든 탭 공통)
let knownAlerts = null; // 처음 불러올 때는 소리를 내지 않는다
let audioCtx = null;
const baseTitle = document.title;

function beep() {
  if (lsGet('cctv_sound') === '0') return;
  try {
    audioCtx = audioCtx || new AudioContext();
    for (const [i, f] of [[0, 880], [1, 660]]) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; g.gain.value = 0.12;
      o.connect(g).connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.25;
      o.start(t); o.stop(t + 0.2);
    }
  } catch { /* 브라우저가 소리를 막음: 화면을 한 번 클릭하면 풀린다 */ }
}

async function loadAlerts() {
  const d = await api('/api/admin/alerts');
  const bar = $('alertBar');
  const keys = new Set(d.active.map(a => `${a.cam_id}:${a.code}`));
  if (knownAlerts && [...keys].some(k => !knownAlerts.has(k))) beep();
  knownAlerts = keys;
  document.title = d.active.length ? `(⚠${d.active.length}) ${baseTitle}` : baseTitle;
  bar.hidden = !d.active.length;
  bar.innerHTML = d.active.length
    ? `<strong>⚠ 카메라 이상 ${d.active.length}건</strong>` + d.active.map(a =>
        `<span class="item">${esc(a.name)}: ${esc(a.message)}${a.since ? ` <span class="muted">(${fmtTime(a.since)}부터)</span>` : ''}</span>`).join('')
    : '';
  if (!$('tab-ops').hidden) renderEvents(d.events);
}

function renderEvents(events) {
  const icon = { alert: '⚠️', recover: '✅', operating: '⏱️', admin: '🛠️' };
  $('events').innerHTML = events.length
    ? events.map(e => `<li><time>${fmtDateTime(e.ts)}</time><span>${icon[e.kind] || '•'} ${esc(e.message)}</span></li>`).join('')
    : '<li class="muted">아직 기록이 없습니다.</li>';
}

// ---------------------------------------------------------------- 운영 시간 / 공지
$('days').innerHTML = [...DAY_NAMES].map((n, i) =>
  `<label><input type="checkbox" value="${i}"> ${n}</label>`).join('');

function selectedMode() {
  return document.querySelector('input[name=mode]:checked')?.value || 'always';
}
function syncSchedFields() {
  const on = selectedMode() === 'schedule';
  $('schedFields').style.opacity = on ? 1 : .45;
  $('schedFields').querySelectorAll('input').forEach(i => { i.disabled = !on; });
}
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', syncSchedFields));

function renderOpStatus(st) {
  $('opStatus').innerHTML = st.active
    ? `🟢 <strong>지금 운영 중</strong>` + (st.ends_at ? ` <span class="muted">· ${fmtTime(st.ends_at)}에 종료</span>` : '')
    : `⏸ <strong>운영하지 않는 중</strong> <span class="muted">· ${esc(st.message)}</span>`;
}

async function loadOps() {
  const d = await api('/api/admin/operation');
  const s = d.schedule;
  document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
  $('days').querySelectorAll('input').forEach(i => { i.checked = s.days.includes(Number(i.value)); });
  $('sStart').value = s.start;
  $('sEnd').value = s.end;
  syncSchedFields();
  renderOpStatus(d.status);
  $('noticeText').value = d.notice.text || '';
  $('noticeLevel').value = d.notice.level || 'info';
  $('noticeState').textContent = d.notice.text ? `게시 중 · ${fmtDateTime(d.notice.updated_at)}` : '게시된 공지 없음';
  $('soundOn').checked = lsGet('cctv_sound') !== '0';
  const st = await api('/api/admin/settings');
  $('tgState').textContent = st.telegram
    ? '텔레그램 알림이 켜져 있습니다.'
    : '텔레그램 알림은 꺼져 있습니다 (설정 탭 참고). 이 화면을 열어 두면 막대와 소리로 알려줍니다.';
  await loadAlerts();
}

$('saveSched').onclick = () => act(async () => {
  const body = {
    mode: selectedMode(),
    days: [...$('days').querySelectorAll('input:checked')].map(i => Number(i.value)),
    start: $('sStart').value || '17:00',
    end: $('sEnd').value || '20:00',
  };
  const d = await api('/api/admin/schedule', { method: 'PUT', body });
  renderOpStatus(d.status);
  await loadAlerts();
}, '운영 시간을 저장했습니다');

async function saveNotice(text) {
  const d = await api('/api/admin/notice', { method: 'PUT', body: { text, level: $('noticeLevel').value } });
  $('noticeText').value = d.text;
  $('noticeState').textContent = d.text ? `게시 중 · ${fmtDateTime(d.updated_at)}` : '게시된 공지 없음';
  await loadAlerts();
}
$('postNotice').onclick = () => {
  if (!$('noticeText').value.trim()) { toast('공지 내용을 입력하세요', true); $('noticeText').focus(); return; }
  act(() => saveNotice($('noticeText').value), '공지를 게시했습니다. 직원 화면에 몇 초 안에 나타납니다');
};
$('clearNotice').onclick = () => act(() => saveNotice(''), '공지를 내렸습니다');
$('soundOn').addEventListener('change', e => {
  lsSet('cctv_sound', e.target.checked ? '1' : '0');
  if (e.target.checked) beep(); // 미리 듣기 + 브라우저 소리 허용
});

// ---------------------------------------------------------------- 통계
let statsData = null;

async function loadStats() {
  statsData = await api('/api/admin/stats');
  const d = statsData;
  $('kNow').textContent = `${d.viewers_now}명`;
  $('kPeak').textContent = `${d.today.peak}명`;
  $('kPeakAt').textContent = d.today.peak_at ? `${fmtTime(d.today.peak_at)} 기록` : '아직 기록 없음';
  $('kUnique').textContent = `${d.today.unique}명`;

  const max = Math.max(1, ...d.cam_views.map(c => c.viewers));
  $('camViews').innerHTML = d.cam_views.length
    ? d.cam_views.map(c => `<div class="hbar"><span>${esc(c.name)}</span>
        <div class="track"><div class="fill" style="width:${(c.viewers / max) * 100}%"></div></div>
        <span class="num">${c.viewers}명</span></div>`).join('')
    : '<p class="muted">카메라가 없습니다.</p>';

  $('dayRows').innerHTML = d.days.slice().reverse().map(r =>
    `<tr><td>${r.day}</td><td>${r.unique}명</td><td>${r.peak}명</td></tr>`).join('');
  drawChart();
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(n => n >= v);
}

function drawChart() {
  if (!statsData) return;
  const svg = $('chart');
  const W = svg.clientWidth || 600, H = 240, L = 40, R = 12, T = 12, B = 26;
  const t1 = statsData.now, t0 = t1 - 24 * 3600;
  const pts = statsData.series;
  const yMax = niceMax(Math.max(0, ...pts.map(p => p[1])));
  const X = t => L + (t - t0) / (t1 - t0) * (W - L - R);
  const Y = v => T + (1 - v / yMax) * (H - T - B);

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = yMax * i / 4, y = Y(v);
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/>`;
    g += `<text class="axis" x="${L - 6}" y="${y + 4}" text-anchor="end">${Math.round(v)}</text>`;
  }
  // 3시간 간격 시각 눈금 (한국 시간 정각)
  const step = 3 * 3600, first = Math.ceil((t0 + 9 * 3600) / step) * step - 9 * 3600;
  for (let t = first; t <= t1; t += step) {
    g += `<text class="axis" x="${X(t)}" y="${H - 6}" text-anchor="middle">${fmtTime(t)}</text>`;
  }

  // 서버가 꺼져 있던 구간(3분 넘게 빈 곳)은 선을 끊는다
  let line = '', area = '', seg = [];
  const flush = () => {
    if (!seg.length) return;
    const d = seg.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    line += d;
    area += `${d}L${X(seg[seg.length - 1][0]).toFixed(1)},${Y(0)}L${X(seg[0][0]).toFixed(1)},${Y(0)}Z`;
    seg = [];
  };
  pts.forEach((p, i) => { if (i && p[0] - pts[i - 1][0] > 180) flush(); seg.push(p); });
  flush();

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g + (pts.length
    ? `<path class="area" d="${area}"/><path class="line" d="${line}"/>
       <line class="cross" id="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
       <circle class="dot" id="hoverDot" r="4" visibility="hidden"/>`
    : `<text class="axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">아직 기록이 없습니다 (1분마다 쌓입니다)</text>`);
  chartGeom = { X, Y, L, R, W, pts };
}

let chartGeom = null;
$('chart').addEventListener('pointermove', e => {
  if (!chartGeom || !chartGeom.pts.length) return;
  const r = $('chart').getBoundingClientRect();
  const x = (e.clientX - r.left) * (chartGeom.W / r.width);
  let best = chartGeom.pts[0];
  for (const p of chartGeom.pts) if (Math.abs(chartGeom.X(p[0]) - x) < Math.abs(chartGeom.X(best[0]) - x)) best = p;
  const px = chartGeom.X(best[0]), py = chartGeom.Y(best[1]);
  const cross = $('cross'), dot = $('hoverDot'), tip = $('tip');
  cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
  dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
  tip.hidden = false;
  tip.textContent = `${fmtTime(best[0])} · ${best[1]}명`;
  tip.style.left = `${px * r.width / chartGeom.W}px`;
  tip.style.top = `${py * r.height / 240}px`;
});
$('chart').addEventListener('pointerleave', () => {
  $('tip').hidden = true;
  $('cross')?.setAttribute('visibility', 'hidden');
  $('hoverDot')?.setAttribute('visibility', 'hidden');
});
addEventListener('resize', () => { if (!$('tab-stats').hidden) drawChart(); });

// ---------------------------------------------------------------- 주기 갱신
loadAlerts().catch(() => {});
setInterval(() => {
  if (document.hidden) return;
  loadAlerts().catch(() => {});
}, 5000);
setInterval(() => {
  if (!document.hidden && !$('tab-stats').hidden) loadStats().catch(() => {});
}, 30000);
