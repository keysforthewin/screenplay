import { loadSession, clearSession } from './auth/session.js';

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
  const res = await fetch(`/api${path}`, { headers: authHeaders() });
  await check(res);
  return res.json();
}

export async function apiPostJson(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  await check(res);
  return res.json();
}

export async function apiPatchJson(path, body) {
  const res = await fetch(`/api${path}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  await check(res);
  return res.json();
}

export async function apiDelete(path) {
  const res = await fetch(`/api${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await check(res);
  return res.json();
}

export async function apiPostMultipart(path, formData) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: authHeaders(), // do NOT set content-type; browser sets boundary
    body: formData,
  });
  await check(res);
  return res.json();
}

export function imageUrl(id) {
  return id ? `/image/${id}` : null;
}

export function attachmentUrl(id) {
  return id ? `/attachment/${id}` : null;
}
