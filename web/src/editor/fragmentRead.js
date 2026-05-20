// Client-side reader for the markdown text currently held in a Y.XmlFragment.
// We need this when a non-editor surface (e.g. the Generate Video dialog)
// wants the latest text the user is typing in a CollabField, without waiting
// for the ~2s Hocuspocus persistence tick to land in Mongo and then in a
// REST refetch. The y-doc local state is always live; this just serializes
// the relevant fragment to markdown via a transient headless Tiptap editor.
//
// Uses the same StarterKit + Markdown + Collaboration stack as CollabField
// so the schema matches and round-tripping is lossless.

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { Markdown } from 'tiptap-markdown';

export function readFragmentMarkdown(ydoc, field) {
  if (!ydoc || !field) return '';
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ history: false }),
      Markdown.configure({ transformPastedText: true, breaks: false }),
      Collaboration.configure({ document: ydoc, field }),
    ],
  });
  try {
    return editor.storage.markdown.getMarkdown() || '';
  } finally {
    editor.destroy();
  }
}
