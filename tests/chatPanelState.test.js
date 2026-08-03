// Persistence helpers for the inline AI chat panel's open flag. Node-run with
// a stubbed localStorage (same pattern as tts-voices.test.js).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadChatOpen, saveChatOpen } from '../web/src/widgets/chatPanelState.js';

function stubStorage() {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  });
  return store;
}

describe('chatPanelState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to closed when nothing is stored', () => {
    stubStorage();
    expect(loadChatOpen()).toBe(false);
  });

  it('round-trips open and closed', () => {
    const store = stubStorage();
    saveChatOpen(true);
    expect(store.get('screenplay_chat_open_v1')).toBe('1');
    expect(loadChatOpen()).toBe(true);
    saveChatOpen(false);
    expect(loadChatOpen()).toBe(false);
  });

  it('treats malformed stored values as closed', () => {
    const store = stubStorage();
    store.set('screenplay_chat_open_v1', 'banana');
    expect(loadChatOpen()).toBe(false);
  });

  it('does not throw without localStorage (node) or when storage throws', () => {
    expect(loadChatOpen()).toBe(false);
    expect(() => saveChatOpen(true)).not.toThrow();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(loadChatOpen()).toBe(false);
    expect(() => saveChatOpen(true)).not.toThrow();
  });
});
