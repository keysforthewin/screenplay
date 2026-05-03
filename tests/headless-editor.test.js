// Smoke test for the server-side headless Tiptap editor that the gateway uses
// when Hocuspocus is running. This is the highest-risk piece because we run
// Tiptap+ProseMirror on Node via JSDOM and rely on the markdown extension's
// behavior matching the client.

import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  setFragmentMarkdown,
  fragmentToMarkdown,
  editFragmentMarkdown,
  appendToFragmentMarkdown,
} = await import('../src/web/headlessEditor.js');

describe('headlessEditor', () => {
  it('round-trips plain text through a Y.XmlFragment', () => {
    const ydoc = new Y.Doc();
    setFragmentMarkdown(ydoc, 'body', 'Hello, world.');
    const out = fragmentToMarkdown(ydoc, 'body');
    expect(out.trim()).toBe('Hello, world.');
  });

  it('round-trips bold and italic markdown', () => {
    const ydoc = new Y.Doc();
    setFragmentMarkdown(ydoc, 'body', 'this is **bold** and *italic*');
    const out = fragmentToMarkdown(ydoc, 'body');
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
  });

  it('preserves multiple fragments independently in one doc', () => {
    const ydoc = new Y.Doc();
    setFragmentMarkdown(ydoc, 'name', 'Steve');
    setFragmentMarkdown(ydoc, 'body', 'Long story');
    expect(fragmentToMarkdown(ydoc, 'name').trim()).toBe('Steve');
    expect(fragmentToMarkdown(ydoc, 'body').trim()).toBe('Long story');
  });

  it('editFragmentMarkdown applies a unique find/replace and returns sizes', () => {
    const ydoc = new Y.Doc();
    setFragmentMarkdown(ydoc, 'body', 'foo bar baz');
    const result = editFragmentMarkdown(ydoc, 'body', [{ find: 'bar', replace: 'BAR' }]);
    expect(result.applied).toHaveLength(1);
    expect(fragmentToMarkdown(ydoc, 'body')).toContain('foo BAR baz');
  });

  it('editFragmentMarkdown rejects an ambiguous find string', () => {
    const ydoc = new Y.Doc();
    setFragmentMarkdown(ydoc, 'body', 'foo foo');
    expect(() =>
      editFragmentMarkdown(ydoc, 'body', [{ find: 'foo', replace: 'FOO' }]),
    ).toThrow(/ambiguous/);
  });

  it('appendToFragmentMarkdown adds with blank-line separator when content exists', () => {
    const ydoc = new Y.Doc();
    setFragmentMarkdown(ydoc, 'body', 'first paragraph');
    appendToFragmentMarkdown(ydoc, 'body', 'second paragraph');
    const out = fragmentToMarkdown(ydoc, 'body');
    expect(out).toMatch(/first paragraph\s+second paragraph/);
  });
});
