import { loadSession, clearSession } from './auth/session.js';

// Vite injects BASE_URL from the build's `base` config (always ends with '/').
// All same-origin fetches and asset URLs need this prefix in production when
// the SPA is served behind a path prefix (e.g. /lucas/).
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

function withBase(p) {
  return `${BASE}${p}`;
}

function authHeaders(extra = {}) {
  const s = loadSession();
  return {
    ...extra,
    ...(s?.session_id ? { 'X-Session-Id': s.session_id } : {}),
  };
}

async function check(res) {
  if (res.status === 401) {
    clearSession();
    location.reload();
    throw new Error('session expired');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `${res.status}`);
  }
  return res;
}

export async function apiGet(path) {
  const res = await fetch(withBase(`/api${path}`), { headers: authHeaders() });
  await check(res);
  return res.json();
}

export async function apiPostJson(path, body) {
  const res = await fetch(withBase(`/api${path}`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  await check(res);
  return res.json();
}

export async function apiPatchJson(path, body) {
  const res = await fetch(withBase(`/api${path}`), {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  await check(res);
  return res.json();
}

export async function apiDelete(path) {
  const res = await fetch(withBase(`/api${path}`), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await check(res);
  return res.json();
}

export async function apiPostMultipart(path, formData) {
  const res = await fetch(withBase(`/api${path}`), {
    method: 'POST',
    headers: authHeaders(), // do NOT set content-type; browser sets boundary
    body: formData,
  });
  await check(res);
  return res.json();
}

export function imageUrl(id) {
  return id ? withBase(`/image/${id}`) : null;
}

export function attachmentUrl(id) {
  return id ? withBase(`/attachment/${id}`) : null;
}
