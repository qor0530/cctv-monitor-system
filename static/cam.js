// 송출 페이지: 카메라 화면을 N초마다 JPEG로 찍어 서버로 올린다.
const KEY_LS = 'cctv_cam_key';
const RUN_LS = 'cctv_cam_running';
const JPEG_QUALITY = 0.72;
const UPLOAD_TIMEOUT_MS = 15000;
const RELOAD_AFTER_FAIL_MS = 2 * 60 * 1000; // 2분 동안 한 번도 성공 못 하면 페이지 재시작

const $ = id => document.getElementById(id);
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 불가 */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* 저장 불가 */ } },
};

let key = null;
let camName = '';
let intervalSec = 5;
let rotation = 0; // 관리자가 정한 회전 각도 (0/90/180/270)
let camActive = true; // 운영 시간 안인지 (서버가 알려준다)
let pauseMsg = '';
const PAUSED_CHECK_MS = 30000;
let stream = null;
let wakeLock = null;
let running = false;
let loopTimer = null;
let lastOk = 0;
let runStarted = 0;
let okCount = 0, failCount = 0;
let battery = null;

function show(id) {
  for (const s of ['setup', 'ready', 'run']) $(s).hidden = s !== id;
}

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  const el = $('log');
  el.textContent = (line + '\n' + el.textContent).slice(0, 3000);
}

// kind: ok(송출 중) / wait(대기) / bad(문제) / ''(준비)
function setStatus(kind, text) {
  $('status').dataset.kind = kind;
  $('stText').textContent = text;
}

async function camFetch(path, init = {}) {
  init.headers = { ...(init.headers || {}), 'X-Camera-Key': key };
  const r = await fetch(path, init);
  let data = null;
  try { data = await r.json(); } catch { /* 본문 없음 */ }
  if (!r.ok) {
    const err = new Error((data && typeof data.detail === 'string' && data.detail) || `오류 ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- 키 설정
function keyFromHash() {
  const m = location.hash.match(/key=([\w-]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname); // 주소창에 키를 남기지 않음
  return m[1];
}

// 서버 응답(설정/업로드)에 담긴 값을 반영한다
function applyCfg(d) {
  if ((d.rotation || 0) !== rotation && running) log(`회전 변경: ${d.rotation || 0}°`);
  if (d.interval !== intervalSec && running) log(`전송 주기 변경: ${d.interval}초`);
  const active = d.active !== false;
  if (active !== camActive && running) log(active ? '운영 시간 시작: 송출을 재개합니다' : '운영 시간 종료: 대기합니다');
  camName = d.name;
  $('rName').textContent = camName;
  intervalSec = d.interval;
  rotation = d.rotation || 0;
  camActive = active;
  pauseMsg = d.message || '';
}

async function checkKey(k) {
  key = k;
  applyCfg(await camFetch('/api/cam/config'));
  store.set(KEY_LS, k);
  $('camName').textContent = camName;
}

$('saveKey').onclick = async () => {
  $('setupErr').textContent = '';
  try {
    await checkKey($('keyInput').value.trim());
    show('ready');
  } catch (e) {
    $('setupErr').textContent = e.message;
  }
};

$('forget').onclick = async e => {
  e.preventDefault();
  if (!(await uiConfirm('이 휴대폰의 카메라 연결을 해제할까요?\n다시 송출하려면 QR을 새로 찍어야 합니다.', { ok: '해제', danger: true }))) return;
  stopRun();
  store.del(KEY_LS);
  key = null;
  show('setup');
};

// ---------------------------------------------------------------- 카메라 / 화면 유지
async function openCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  const video = $('video');
  video.srcObject = stream;
  await video.play();
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (!running) return;
    log('카메라가 끊겼습니다. 다시 여는 중');
    setTimeout(() => openCamera().catch(err => log('카메라 다시 열기 실패: ' + err.message)), 1000);
  });
}

async function keepAwake() {
  if (!('wakeLock' in navigator)) { $('rWake').textContent = '지원 안 됨 (화면 꺼짐 설정을 직접 끄세요)'; return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    $('rWake').textContent = '켜짐';
    wakeLock.addEventListener('release', () => { $('rWake').textContent = '해제됨'; });
  } catch (e) {
    $('rWake').textContent = '실패: ' + e.message;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.hidden) log('화면이 가려졌습니다. 이 상태에서는 송출이 멈출 수 있습니다');
  else { keepAwake(); log('화면 복귀'); }
});

async function initBattery() {
  if (!navigator.getBattery) return;
  try {
    battery = await navigator.getBattery();
    const upd = () => {
      $('rBat').textContent = `${Math.round(battery.level * 100)}%` + (battery.charging ? ' (충전 중)' : ' (충전 안 됨!)');
    };
    battery.addEventListener('levelchange', upd);
    battery.addEventListener('chargingchange', upd);
    upd();
  } catch { /* 지원 안 됨 */ }
}

// ---------------------------------------------------------------- 촬영 / 전송
function capture() {
  const video = $('video');
  if (!video.videoWidth) throw new Error('카메라 준비 중');
  const canvas = $('canvas');
  const vw = video.videoWidth, vh = video.videoHeight;
  const sideways = rotation === 90 || rotation === 270;
  canvas.width = sideways ? vh : vw;
  canvas.height = sideways ? vw : vh;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.drawImage(video, -vw / 2, -vh / 2);
  ctx.restore();

  // 사진에 카메라 이름과 촬영 시각을 새겨 넣는다
  const fs = Math.max(16, Math.round(canvas.height / 32));
  const text = `${camName}  ${new Date().toLocaleString('ko-KR', { hour12: false })}`;
  ctx.font = `600 ${fs}px sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(0, canvas.height - fs * 1.8, w + fs * 1.2, fs * 1.8);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, fs * 0.6, canvas.height - fs * 0.55);

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('사진 변환 실패'))), 'image/jpeg', JPEG_QUALITY));
}

async function sendOnce() {
  const blob = await capture();
  const headers = { 'Content-Type': 'image/jpeg' };
  if (battery) {
    headers['X-Battery'] = String(battery.level);
    headers['X-Charging'] = battery.charging ? '1' : '0';
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const d = await camFetch('/api/cam/upload', { method: 'POST', body: blob, headers, signal: ctrl.signal });
    applyCfg(d);
    return blob.size;
  } finally {
    clearTimeout(to);
  }
}

async function loop() {
  if (!running) return;
  let waitMs = null;
  try {
    // 운영 시간 밖이면 사진을 찍지 않고 30초마다 상태만 확인한다
    if (!camActive) applyCfg(await camFetch('/api/cam/config'));
    if (camActive) {
      const size = await sendOnce();
      if (camActive) {
        okCount++;
        setStatus('ok', '송출 중');
        $('rLast').textContent = `${new Date().toLocaleTimeString()} (${Math.round(size / 1024)}KB)`;
      }
    }
    lastOk = Date.now();
    if (!camActive) {
      setStatus('wait', '운영 시간 대기 중');
      $('rLast').textContent = pauseMsg || '-';
      waitMs = PAUSED_CHECK_MS;
    }
  } catch (e) {
    failCount++;
    if (e.status === 401 || e.status === 403) {
      setStatus('bad', '송출 중단: ' + e.message);
      log('송출 중단: ' + e.message + ' (관리자에게 문의)');
      stopRun(false);
      return;
    }
    setStatus('bad', '전송 실패, 재시도 중');
    log('전송 실패: ' + (e.name === 'AbortError' ? '시간 초과' : e.message));
    if (Date.now() - Math.max(lastOk, runStarted) > RELOAD_AFTER_FAIL_MS) {
      log('오래 실패해서 페이지를 다시 시작합니다');
      setTimeout(() => location.reload(), 1000);
      return;
    }
  }
  $('rCount').textContent = `${okCount} / ${failCount}`;
  $('rInt').textContent = `${intervalSec}초` + (rotation ? ` · 회전 ${rotation}°` : '');
  $('rName').textContent = camName;
  loopTimer = setTimeout(loop, waitMs ?? intervalSec * 1000);
}

async function startRun() {
  $('readyErr').textContent = '';
  show('run');
  setStatus('', '카메라 여는 중');
  try {
    await openCamera();
  } catch (e) {
    show('ready');
    $('readyErr').textContent = '카메라를 열 수 없습니다: ' + e.message +
      (location.protocol !== 'https:' && location.hostname !== 'localhost' ? ' (HTTPS 주소로 접속해야 합니다)' : '');
    return;
  }
  await keepAwake();
  await initBattery();
  running = true;
  runStarted = Date.now();
  store.set(RUN_LS, '1');
  log('송출 시작');
  loop();
}

function stopRun(clearFlag = true) {
  running = false;
  document.body.classList.remove('aiming');
  clearTimeout(loopTimer);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (clearFlag) store.del(RUN_LS);
}

$('start').onclick = startRun;
$('stop').onclick = async () => {
  if (!(await uiConfirm('송출을 중지할까요?\n직원 화면에서 이 카메라가 "연결 안 됨"으로 바뀝니다.', { ok: '중지', danger: true }))) return;
  stopRun();
  log('송출 중지');
  show('ready');
};
$('dimBtn').onclick = () => { $('dim').hidden = false; };
// 화각 맞추기: 미리보기를 전체 화면으로 키우고 3분할 안내선을 보여준다.
// 안내선은 화면 전체가 아니라 실제 사진이 보이는 영역에 맞춘다.
function fitGuide() {
  const v = $('video'), box = document.querySelector('.preview'), g = document.querySelector('.guide');
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const W = box.clientWidth, H = box.clientHeight, k = Math.min(W / vw, H / vh);
  Object.assign(g.style, { width: `${vw * k}px`, height: `${vh * k}px`,
                           left: `${(W - vw * k) / 2}px`, top: `${(H - vh * k) / 2}px` });
}
$('aimBtn').onclick = () => { document.body.classList.add('aiming'); fitGuide(); };
$('aimDone').onclick = () => document.body.classList.remove('aiming');
addEventListener('resize', () => { if (document.body.classList.contains('aiming')) fitGuide(); });
$('dim').onclick = () => { $('dim').hidden = true; };

// ---------------------------------------------------------------- 시작
(async () => {
  const k = keyFromHash() || store.get(KEY_LS);
  if (!k) { show('setup'); return; }
  try {
    await checkKey(k);
  } catch (e) {
    show('setup');
    $('keyInput').value = k;
    $('setupErr').textContent = e.message;
    return;
  }
  show('ready');
  // 자동 재시작된 경우 바로 송출을 이어간다
  if (store.get(RUN_LS) === '1') startRun();
})();
