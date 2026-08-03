// Persist the inline AI chat panel's open/closed state so a reload restores
// it. Shared by ProjectShell (state init + writes) and the legacy /chat
// redirect, which flips the flag before bouncing into the project so the
// panel lands open. Key follows the repo's `screenplay_*_v1` convention.
const KEY = 'screenplay_chat_open_v1';

export function loadChatOpen() {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function saveChatOpen(open) {
  try {
    globalThis.localStorage?.setItem(KEY, open ? '1' : '0');
  } catch {
    // best-effort: private mode / disabled storage just loses persistence
  }
}
