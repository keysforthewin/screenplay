// Launches the AI chat as a separate popup window. Named per project so that
// clicking "AI chat" again reuses and focuses the existing popup instead of
// spawning duplicates (browser window-name reuse). Pure: the caller passes the
// window object, so it's unit-testable and DOM-free in tests.

// Vite injects BASE_URL from vite.config.js's `base` (always ends with '/').
// In production the SPA may be served behind a path prefix (WEB_BASE_PATH=/lucas/),
// so the popup URL MUST carry that prefix — window.open() resolves a root-absolute
// path against the origin, dropping the prefix and 404ing. Mirrors api.js's
// withBase()/projectHomeUrl() and main.jsx's basename.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

const CHAT_WINDOW_FEATURES =
  'width=480,height=800,menubar=no,toolbar=no,location=no,status=no';

export function chatWindowName(projectId) {
  return `screenplay-chat-${projectId}`;
}

export function chatWindowUrl(projectTitle) {
  return `${BASE}/p/${encodeURIComponent(projectTitle)}/chat`;
}

export function openChatWindow(win, project) {
  const w = win.open(
    chatWindowUrl(project.title),
    chatWindowName(project.id),
    CHAT_WINDOW_FEATURES,
  );
  w?.focus?.();
  return w;
}
