// Markdown → speakable plain text for TTS. Uses the same StarterKit + Markdown
// stack as CollabField so headings, emphasis, lists, and links strip exactly
// the way the editor renders them (rather than a hand-rolled regex pass).

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

export function markdownToText(md) {
  const src = String(md || '').trim();
  if (!src) return '';
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ history: false }),
      Markdown.configure({ transformPastedText: true, breaks: false }),
    ],
    content: src,
  });
  try {
    return editor.getText({ blockSeparator: '\n\n' }).trim();
  } finally {
    editor.destroy();
  }
}
