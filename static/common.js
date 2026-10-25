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

async function logout() {
  try { await api('/api/logout', { method: 'POST', noRedirect: true }); } finally { location.href = '/login'; }
}
