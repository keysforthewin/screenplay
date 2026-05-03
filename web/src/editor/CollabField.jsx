import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { Markdown } from 'tiptap-markdown';
import { useCollabRoom } from './CollabSurface.jsx';

function colorForUser(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 55%)`;
}

export function CollabField({ label, field, multiline = false, placeholder }) {
  const { provider, ydoc, session } = useCollabRoom();

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          // Collaboration extension provides its own undo/redo history.
          history: false,
        }),
        Markdown.configure({
          transformPastedText: true,
          breaks: false,
        }),
        Collaboration.configure({ document: ydoc, field }),
        CollaborationCursor.configure({
          provider,
          user: {
            name: session.username,
            color: colorForUser(session.username),
          },
        }),
      ],
      // Empty content; Yjs hydration kicks in on first sync.
      content: '',
      // Single-line behavior: disable Enter for non-multiline fields.
      editorProps: multiline
        ? {}
        : {
            handleKeyDown(_view, event) {
              if (event.key === 'Enter') return true;
              return false;
            },
          },
    },
    [provider, ydoc, field, session.username, multiline],
  );

  return (
    <div className="field-block">
      {label && <span className="field-label">{label}</span>}
      <div className={`editor-shell${multiline ? '' : ' single-line'}`}>
        <EditorContent editor={editor} />
        {placeholder && (!editor || editor.isEmpty) && (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 4 }}>
            {placeholder}
          </div>
        )}
      </div>
    </div>
  );
}
