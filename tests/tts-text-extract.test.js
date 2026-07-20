// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { Markdown } from 'tiptap-markdown';
import { markdownToText } from '../web/src/tts/markdownToText.js';
import { readFragmentText } from '../web/src/editor/fragmentRead.js';

describe('markdownToText', () => {
  it('strips markdown syntax to speakable plain text', () => {
    const md = '# The Heist\n\nSteve walks in **slowly**. He sees *the vault*.\n\n- one\n- two';
    const text = markdownToText(md);
    expect(text).not.toMatch(/[#*-]/);
    expect(text).toContain('The Heist');
    expect(text).toContain('Steve walks in slowly. He sees the vault.');
    expect(text).toContain('one');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(markdownToText('')).toBe('');
    expect(markdownToText('   \n ')).toBe('');
    expect(markdownToText(null)).toBe('');
  });
});

describe('readFragmentText', () => {
  it('reads live plain text from a y-doc fragment', () => {
    const ydoc = new Y.Doc();
    // Populate the 'body' fragment the same way CollabField does.
    const writer = new Editor({
      extensions: [
        StarterKit.configure({ history: false }),
        Markdown.configure({ transformPastedText: true, breaks: false }),
        Collaboration.configure({ document: ydoc, field: 'body' }),
      ],
    });
    writer.commands.setContent('He runs. **Fast.**');
    const text = readFragmentText(ydoc, 'body');
    writer.destroy();
    expect(text).toContain('He runs.');
    expect(text).toContain('Fast.');
    expect(text).not.toContain('**');
  });

  it('returns empty string when ydoc/field missing', () => {
    expect(readFragmentText(null, 'body')).toBe('');
    expect(readFragmentText(new Y.Doc(), '')).toBe('');
  });
});
