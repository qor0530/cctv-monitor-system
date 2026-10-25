// 공통: JSON API 호출과 HTML 이스케이프
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(path, init);
  if (r.status === 401 && !opts.noRedirect) {
    location.href = '/login';
    throw new Error('로그인이 필요합니다');
  }
  let data = null;
  try { data = await r.json(); } catch { /* 본문 없음 */ }
  if (!r.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === 'string' ? detail : `요청 실패 (${r.status})`);
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ago(sec) {
  if (sec == null) return '없음';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
}

// 화면 디자인에 맞춘 확인 창. 확인을 누르면 true.
function uiConfirm(message, { ok = '확인', danger = false } = {}) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'ui-dialog';
    d.innerHTML = `<p></p><div class="ui-dialog-actions">
      <button class="btn" value="no">취소</button>
      <button class="btn ${danger ? 'danger-fill' : 'primary'}" value="yes"></button></div>`;
    d.querySelector('p').textContent = message;
    d.querySelector('[value=yes]').textContent = ok;
    d.addEventListener('click', e => {
      const v = e.target.closest('button')?.value;
      if (v) { d.close(v); return; }
      const r = d.getBoundingClientRect(); // 바깥(배경) 클릭이면 취소
      if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close('no');
    });
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    document.body.appendChild(d);
    d.showModal();
    d.querySelector('[value=yes]').focus();
  });
}

async function logout() {
  try { await api('/api/logout', { method: 'POST', noRedirect: true }); } finally { location.href = '/login'; }
}
