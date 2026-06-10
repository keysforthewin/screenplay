import { loadSession, clearSession } from './auth/session.js';

// Vite injects BASE_URL from the build's `base` config (always ends with '/').
// All same-origin fetches and asset URLs need this prefix in production when
// the SPA is served behind a path prefix (e.g. /lucas/).
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

function withBase(p) {
  return `${BASE}${p}`;
}

// ---------------------------------------------------------------------------
// Current-project store (module-level, not a hook — same pattern as
// auth/session.js#loadSession). ProjectProvider calls setCurrentProject()
// once the URL's :projectTitle resolves; every subsequent fetch carries the
// X-Project-Id header and SSE URLs carry &project_id=.
// ---------------------------------------------------------------------------

const PROJECT_KEY = 'screenplay_project_v1';

let currentProject = null; // { id, title } | null

export function setCurrentProject(p) {
  currentProject = p?.id && p?.title
    ? { id: String(p.id), title: String(p.title) }
    : null;
  if (!currentProject) return;
  try {
    localStorage.setItem(
      PROJECT_KEY,
      JSON.stringify({ project_id: currentProject.id, title: currentProject.title }),
    );
  } catch {
    // localStorage unavailable (private mode) — the header still works for this tab.
  }
}

export function getCurrentProject() {
  return currentProject;
}

// Last project this BROWSER viewed (vs getCurrentProject() = this TAB).
// Used by RedirectToProject for legacy URLs opened in a fresh tab.
export function loadStoredProject() {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.project_id || !parsed?.title) return null;
    return { id: String(parsed.project_id), title: String(parsed.title) };
  } catch {
    return null;
  }
}

// Canonical URL of a project's TOC. Full-reload project switches use
// location.assign(projectHomeUrl(title)).
export function projectHomeUrl(title) {
  return withBase(`/p/${encodeURIComponent(title)}/`);
}

function authHeaders(extra = {}) {
  const s = loadSession();
  return {
    ...extra,
    ...(s?.session_id ? { 'X-Session-Id': s.session_id } : {}),
    ...(currentProject?.id ? { 'X-Project-Id': currentProject.id } : {}),
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
    throw new Error(extractErrorMessage(body) || `${res.status}`);
  }
  return res;
}

function extractErrorMessage(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.error === 'string') return parsed.error;
      if (typeof parsed.message === 'string') return parsed.message;
    }
  } catch {
    // not JSON — fall through and return the raw body.
  }
  return body;
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

export function thumbUrl(id) {
  return id ? withBase(`/image/${id}/thumb`) : null;
}

export function attachmentUrl(id) {
  return id ? withBase(`/attachment/${id}`) : null;
}

// EventSource cannot set custom headers, so SSE endpoints must accept a
// session id via query string. The server applies the same getSession
// check it would for a header-bearing request.
export function apiSseUrl(path) {
  const s = loadSession();
  const sep = path.includes('?') ? '&' : '?';
  const project = currentProject?.id
    ? `&project_id=${encodeURIComponent(currentProject.id)}`
    : '';
  return `${withBase(`/api${path}`)}${sep}session_id=${encodeURIComponent(s?.session_id || '')}${project}`;
}
