import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { Markdown } from 'tiptap-markdown';
import { useCollabRoom } from './CollabSurface.jsx';
import { colorForUser } from './userColor.js';

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
        {editor && <FormattingBubbleMenu editor={editor} multiline={multiline} />}
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

function FormattingBubbleMenu({ editor, multiline }) {
  const btn = (active, onClick, label, title) => (
    <button
      type="button"
      title={title}
      className={active ? 'is-active' : ''}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
    >
      {label}
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{ duration: 100, placement: 'top' }}
      className="bubble-menu"
    >
      {btn(editor.isActive('bold'),
        () => editor.chain().focus().toggleBold().run(),
        <strong>B</strong>, 'Bold (⌘B)')}
      {btn(editor.isActive('italic'),
        () => editor.chain().focus().toggleItalic().run(),
        <em>I</em>, 'Italic (⌘I)')}
      {btn(editor.isActive('strike'),
        () => editor.chain().focus().toggleStrike().run(),
        <span style={{ textDecoration: 'line-through' }}>S</span>, 'Strikethrough')}
      {btn(editor.isActive('code'),
        () => editor.chain().focus().toggleCode().run(),
        <span style={{ fontFamily: 'monospace' }}>{'</>'}</span>, 'Inline code')}
      {multiline && (
        <>
          <span className="bubble-menu-sep" aria-hidden="true" />
          {btn(editor.isActive('heading', { level: 1 }),
            () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
            'H1', 'Heading 1')}
          {btn(editor.isActive('heading', { level: 2 }),
            () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
            'H2', 'Heading 2')}
          {btn(editor.isActive('heading', { level: 3 }),
            () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
            'H3', 'Heading 3')}
          <span className="bubble-menu-sep" aria-hidden="true" />
          {btn(editor.isActive('bulletList'),
            () => editor.chain().focus().toggleBulletList().run(),
            '•', 'Bullet list')}
          {btn(editor.isActive('orderedList'),
            () => editor.chain().focus().toggleOrderedList().run(),
            '1.', 'Numbered list')}
        </>
      )}
    </BubbleMenu>
  );
}
