// 관리자 화면: 카메라, 계정, 설정
const $ = id => document.getElementById(id);
let camList = [];
let userList = [];
let skew = 0;
let editingCam = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { alert(e.message); }
}

// ---------------------------------------------------------------- 탭
document.querySelectorAll('nav.tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('nav.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
    for (const s of ['cams', 'users', 'settings']) $('tab-' + s).hidden = s !== b.dataset.tab;
    if (b.dataset.tab === 'users') loadUsers();
    if (b.dataset.tab === 'settings') loadSettings();
  };
});

// ---------------------------------------------------------------- 카메라
async function loadCams() {
  const d = await api('/api/admin/cameras');
  skew = d.now - Date.now() / 1000;
  camList = d.cameras;
  renderCams();
}

function renderCams() {
  const now = Date.now() / 1000 + skew;
  $('camCount').textContent = `(${camList.length})`;
  $('camRows').innerHTML = camList.map(c => {
    const st = !c.enabled ? '<span class="pill">비활성</span>'
      : c.online ? '<span class="pill ok">온라인</span>' : '<span class="pill bad">오프라인</span>';
    const bat = c.battery == null ? '-'
      : `${Math.round(c.battery * 100)}%` + (c.charging ? ' ⚡' : ' <span class="pill warn">충전 안 됨</span>');
    return `<tr>
      <td>${c.sort}</td>
      <td>${esc(c.name)}</td>
      <td>${esc(c.location) || '<span class="muted">-</span>'}</td>
      <td>${st}</td>
      <td>${c.ts ? ago(now - c.ts) : '<span class="muted">없음</span>'}</td>
      <td>${bat}</td>
      <td>${c.interval}초${c.rotation ? ` · ${c.rotation}°` : ''}</td>
      <td class="actions">
        <button class="btn sm" data-act="rot" data-id="${c.id}" title="시계 방향으로 90° 회전">↻ 회전</button>
        <button class="btn sm" data-act="edit" data-id="${c.id}">수정</button>
        <button class="btn sm" data-act="toggle" data-id="${c.id}">${c.enabled ? '비활성화' : '활성화'}</button>
        <button class="btn sm" data-act="rotate" data-id="${c.id}">키 재발급</button>
        <button class="btn sm danger" data-act="del" data-id="${c.id}">삭제</button>
      </td></tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">카메라가 없습니다. "카메라 추가"를 눌러 시작하세요.</td></tr>';
}

$('camRows').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const c = camList.find(c => c.id === Number(b.dataset.id));
  if (!c) return;
  if (b.dataset.act === 'edit') openCamDlg(c);
  if (b.dataset.act === 'rot') act(async () => {
    const rotation = (c.rotation + 90) % 360;
    await api(`/api/admin/cameras/${c.id}`, { method: 'PATCH', body: { rotation } });
    await loadCams();
  }, `회전 ${(c.rotation + 90) % 360}° · 다음 사진부터 적용됩니다`);
  if (b.dataset.act === 'toggle') act(async () => {
    await api(`/api/admin/cameras/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } });
    await loadCams();
  }, c.enabled ? '비활성화했습니다. 송출이 중단됩니다' : '활성화했습니다');
  if (b.dataset.act === 'rotate') {
    if (!confirm(`"${c.name}" 키를 재발급할까요? 지금 연결된 휴대폰은 송출이 끊깁니다.`)) return;
    act(async () => {
      const d = await api(`/api/admin/cameras/${c.id}/rotate-key`, { method: 'POST' });
      showKey(c.name, d.key);
      await loadCams();
    });
  }
  if (b.dataset.act === 'del') {
    if (!confirm(`"${c.name}" 카메라를 삭제할까요?`)) return;
    act(async () => { await api(`/api/admin/cameras/${c.id}`, { method: 'DELETE' }); await loadCams(); }, '삭제했습니다');
  }
});

function openCamDlg(c) {
  editingCam = c || null;
  $('camDlgTitle').textContent = c ? '카메라 수정' : '카메라 추가';
  $('fName').value = c ? c.name : '';
  $('fLoc').value = c ? c.location : '';
  $('fInt').value = c ? c.interval : 5;
  $('fRot').value = c ? c.rotation : 0;
  $('fSort').value = c ? c.sort : camList.length;
  $('camErr').textContent = '';
  $('camDlg').showModal();
}
$('addCam').onclick = () => openCamDlg(null);

$('camForm').addEventListener('submit', async e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const body = { name: $('fName').value, location: $('fLoc').value, interval_sec: Number($('fInt').value),
                 rotation: Number($('fRot').value) };
  const sort = Number($('fSort').value) || 0;
  try {
    if (editingCam) {
      await api(`/api/admin/cameras/${editingCam.id}`, { method: 'PATCH', body: { ...body, sort } });
      $('camDlg').close();
      toast('저장했습니다');
    } else {
      const d = await api('/api/admin/cameras', { method: 'POST', body: { ...body, sort } });
      $('camDlg').close();
      showKey(body.name, d.key);
    }
    await loadCams();
  } catch (ex) {
    $('camErr').textContent = ex.message;
  }
});

function showKey(name, key) {
  const url = `${location.origin}/cam#key=${key}`;
  $('keyTitle').textContent = `${name} 연결`;
  $('keyUrl').textContent = url;
  $('qr').innerHTML = '';
  if (window.QRCode) new QRCode($('qr'), { text: url, width: 220, height: 220 });
  else $('qr').hidden = true;
  $('copyKey').onclick = () => navigator.clipboard.writeText(url).then(() => toast('복사했습니다'), () => alert(url));
  $('keyDlg').showModal();
}

// ---------------------------------------------------------------- 계정
async function loadUsers() {
  const d = await api('/api/admin/users');
  userList = d.users;
  renderUsers();
}

function renderUsers() {
  const f = $('userSearch').value.trim();
  const list = f ? userList.filter(u => u.username.includes(f)) : userList;
  const blocked = userList.filter(u => u.blocked).length;
  $('userCount').textContent = `(전체 ${userList.length}명 · 차단 ${blocked}명)`;
  const now = Date.now() / 1000;
  $('userRows').innerHTML = list.slice(0, 500).map(u => `
    <tr class="${u.blocked ? 'blocked' : ''}">
      <td>${esc(u.username)}</td>
      <td>${u.is_admin ? '<span class="pill ok">관리자</span>' : '사용자'}</td>
      <td>${u.blocked ? '<span class="pill bad">차단</span>' : '정상'}</td>
      <td>${u.must_change ? '<span class="pill warn">초기값</span>' : '변경함'}</td>
      <td>${u.last_login ? ago(now - u.last_login) : '<span class="muted">없음</span>'}</td>
      <td class="actions">
        <button class="btn sm" data-act="block" data-id="${u.id}">${u.blocked ? '차단 해제' : '차단'}</button>
        <button class="btn sm" data-act="reset" data-id="${u.id}">비밀번호 초기화</button>
        <button class="btn sm" data-act="admin" data-id="${u.id}">${u.is_admin ? '관리자 해제' : '관리자 지정'}</button>
        <button class="btn sm danger" data-act="del" data-id="${u.id}">삭제</button>
      </td>
    </tr>`).join('')
    + (list.length > 500 ? `<tr><td colspan="6" class="muted">${list.length - 500}명 더 있음. 검색으로 좁혀보세요.</td></tr>` : '')
    || '<tr><td colspan="6" class="muted">계정이 없습니다.</td></tr>';
}

$('userSearch').addEventListener('input', renderUsers);

$('userRows').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const u = userList.find(u => u.id === Number(b.dataset.id));
  if (!u) return;
  const reload = () => loadUsers();
  if (b.dataset.act === 'block') act(async () => {
    await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { blocked: !u.blocked } });
    await reload();
  }, u.blocked ? '차단을 해제했습니다' : '차단했습니다. 즉시 로그아웃됩니다');
  if (b.dataset.act === 'reset') {
    if (!confirm(`${u.username}의 비밀번호를 사번으로 초기화할까요?`)) return;
    act(async () => { await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' }); await reload(); },
      '비밀번호를 사번으로 초기화했습니다');
  }
  if (b.dataset.act === 'admin') {
    if (!confirm(u.is_admin ? `${u.username}의 관리자 권한을 해제할까요?` : `${u.username}을(를) 관리자로 지정할까요?`)) return;
    act(async () => {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { is_admin: !u.is_admin } });
      await reload();
    });
  }
  if (b.dataset.act === 'del') {
    if (!confirm(`${u.username} 계정을 삭제할까요?`)) return;
    act(async () => { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); await reload(); }, '삭제했습니다');
  }
});

$('bulkGo').onclick = async () => {
  const names = $('bulk').value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (!names.length) { $('bulkResult').textContent = '사번을 입력하세요'; return; }
  $('bulkGo').disabled = true;
  $('bulkResult').textContent = `${names.length}개 처리 중...`;
  try {
    const d = await api('/api/admin/users/bulk', { method: 'POST', body: { usernames: names } });
    let msg = `생성 ${d.created.length}명`;
    if (d.existing.length) msg += ` · 이미 있음 ${d.existing.length}명`;
    if (d.invalid.length) msg += ` · 형식 오류 ${d.invalid.length}개 (${d.invalid.slice(0, 5).map(esc).join(', ')}${d.invalid.length > 5 ? ' …' : ''})`;
    $('bulkResult').innerHTML = msg;
    if (d.created.length) $('bulk').value = '';
    await loadUsers();
  } catch (e) {
    $('bulkResult').textContent = e.message;
  } finally {
    $('bulkGo').disabled = false;
  }
};

// ---------------------------------------------------------------- 설정
async function loadSettings() {
  const d = await api('/api/admin/settings');
  $('forcePw').checked = d.force_pw_change;
}
$('forcePw').addEventListener('change', e => act(
  () => api('/api/admin/settings', { method: 'PUT', body: { force_pw_change: e.target.checked } }),
  '저장했습니다'));

// ---------------------------------------------------------------- 시작
loadCams().catch(e => alert(e.message));
setInterval(() => { if (!document.hidden && !$('tab-cams').hidden) loadCams().catch(() => {}); }, 5000);
