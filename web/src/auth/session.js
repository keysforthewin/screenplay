const KEY = 'screenplay_session_v1';

export function loadSession() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.session_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession({ session_id, username }) {
  localStorage.setItem(KEY, JSON.stringify({ session_id, username }));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}

export async function validateSession(sessionId) {
  const res = await fetch('/auth/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) return { valid: false };
  return res.json();
}

export async function requestApproval(username) {
  const res = await fetch('/auth/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `request failed (${res.status})`);
  }
  return res.json();
}

export async function pollStatus(requestId) {
  const res = await fetch(`/auth/status?request_id=${encodeURIComponent(requestId)}`);
  if (!res.ok) throw new Error(`status failed (${res.status})`);
  return res.json();
}
