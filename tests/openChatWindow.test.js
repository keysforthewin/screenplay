// openChatWindow.js wraps window.open so the Header button can launch the AI
// chat in a named popup. Tested with a fake window object (no real DOM).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chatWindowName,
  chatWindowUrl,
  openChatWindow,
} from '../web/src/widgets/openChatWindow.js';

describe('openChatWindow', () => {
  it('names the window per project so re-clicks reuse/focus it', () => {
    expect(chatWindowName('64af00000000000000000001')).toBe(
      'screenplay-chat-64af00000000000000000001',
    );
  });

  it('builds the chat route URL with an encoded title', () => {
    expect(chatWindowUrl('My Movie')).toBe('/p/My%20Movie/chat');
  });

  it('opens a named popup at the chat URL and focuses it', () => {
    const focus = vi.fn();
    const win = { open: vi.fn(() => ({ focus })) };
    const project = { id: 'pid1', title: 'Western' };
    const result = openChatWindow(win, project);
    expect(win.open).toHaveBeenCalledTimes(1);
    const [url, name, features] = win.open.mock.calls[0];
    expect(url).toBe('/p/Western/chat');
    expect(name).toBe('screenplay-chat-pid1');
    expect(features).toContain('width=480');
    expect(features).toContain('height=800');
    expect(focus).toHaveBeenCalled();
    expect(result).toEqual({ focus });
  });

  it('does not throw when the popup is blocked (open returns null)', () => {
    const win = { open: vi.fn(() => null) };
    expect(() => openChatWindow(win, { id: 'p', title: 't' })).not.toThrow();
  });
});

// In production the SPA is served behind a path prefix (WEB_BASE_PATH=/lucas/ →
// import.meta.env.BASE_URL). Like api.js#projectHomeUrl, the chat URL MUST carry
// that prefix; otherwise window.open() resolves a root-absolute path against the
// origin, drops the prefix, and the popup 404s. Regression for that bug.
describe('openChatWindow base-path handling', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prefixes the SPA base path so the popup does not 404 behind a reverse proxy', async () => {
    vi.stubEnv('BASE_URL', '/lucas/');
    vi.resetModules();
    const mod = await import('../web/src/widgets/openChatWindow.js');

    expect(mod.chatWindowUrl('My Movie')).toBe('/lucas/p/My%20Movie/chat');

    const win = { open: vi.fn(() => ({ focus: vi.fn() })) };
    mod.openChatWindow(win, { id: 'pid1', title: 'Western' });
    expect(win.open.mock.calls[0][0]).toBe('/lucas/p/Western/chat');
  });
});
