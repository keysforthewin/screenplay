// openChatWindow.js wraps window.open so the Header button can launch the AI
// chat in a named popup. Tested with a fake window object (no real DOM).
import { describe, it, expect, vi } from 'vitest';
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
