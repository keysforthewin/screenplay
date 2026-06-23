// Launches the AI chat as a separate popup window. Named per project so that
// clicking "AI chat" again reuses and focuses the existing popup instead of
// spawning duplicates (browser window-name reuse). Pure: the caller passes the
// window object, so it's unit-testable and DOM-free in tests.

const CHAT_WINDOW_FEATURES =
  'width=480,height=800,menubar=no,toolbar=no,location=no,status=no';

export function chatWindowName(projectId) {
  return `screenplay-chat-${projectId}`;
}

export function chatWindowUrl(projectTitle) {
  return `/p/${encodeURIComponent(projectTitle)}/chat`;
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
