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

// Authenticated GET that streams a binary response into a download. The session
// is in a header (not a cookie), so a plain <a download> wouldn't work.
export async function apiDownload(path, fallbackName) {
  const res = await fetch(withBase(`/api${path}`), { headers: authHeaders() });
  await check(res);
  const filename = filenameFromContentDisposition(res.headers.get('content-disposition')) || fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer revoke so the browser has a tick to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function filenameFromContentDisposition(value) {
  if (!value) return null;
  // Tolerate filename* and filename= forms; we only emit ASCII filename= server-side.
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(value);
  return m ? decodeURIComponent(m[1]) : null;
}

export function imageUrl(id) {
  return id ? withBase(`/image/${id}`) : null;
}

export function attachmentUrl(id) {
  return id ? withBase(`/attachment/${id}`) : null;
}
