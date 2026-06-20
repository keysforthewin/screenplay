import { useEffect, useState } from 'react';
import { apiPostJson } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { AudioSlot } from './AudioSlot.jsx';
import { DialogContextStrip } from './DialogContextStrip.jsx';

// Distraction-free "Perform" view. Steps through a beat's lines one at a time,
// showing the previous line, the AI "Direction" note, the line itself (large),
// and the next line — with the record control right there so whoever is voicing
// the line can perform straight from the page.
//
// Rendered IN PLACE OF the dialog list (inside the same <CollabSurface>), so at
// most one editor is ever bound to each y-doc fragment — mounting a second
// editor on the same fragment would fight over the shared cursor/CRDT state.
export function DialogPerform({ items, onAudioChange, onClose }) {
  const [index, setIndex] = useState(0);
  const [genDir, setGenDir] = useState(false);
  const [genDirError, setGenDirError] = useState(null);

  const count = items.length;
  const safeIndex = Math.min(index, Math.max(0, count - 1));
  const current = items[safeIndex] || null;
  const prev = items[safeIndex - 1] || null;
  const next = items[safeIndex + 1] || null;
  const id = current ? current._id?.toString?.() || String(current._id) : null;

  function go(delta) {
    setGenDirError(null);
    setIndex((i) => {
      const from = Math.min(i, count - 1);
      return Math.min(count - 1, Math.max(0, from + delta));
    });
  }

  // Keyboard: ← / → move between lines, Esc closes. Ignore arrow keys while a
  // text editor (the ProseMirror surface) or an input is focused, so editing
  // the note or line doesn't jump away.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
      const t = e.target;
      const editing =
        t &&
        (t.isContentEditable ||
          (t.closest && t.closest('.ProseMirror')) ||
          t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA');
      if (editing) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, onClose]);

  async function generateDirection() {
    if (!id) return;
    setGenDir(true);
    setGenDirError(null);
    try {
      await apiPostJson(`/dialog/${id}/direction`, {});
    } catch (e) {
      setGenDirError(e.message);
    } finally {
      setGenDir(false);
    }
  }

  if (!current) {
    return (
      <div className="dialog-perform">
        <div className="dialog-perform-header">
          <span className="dialog-perform-progress">Nothing to perform</span>
          <button type="button" className="dialog-perform-close" onClick={onClose}>
            ✕ Close
          </button>
        </div>
        <p style={{ color: 'var(--fg-muted)' }}>This beat has no dialog lines yet.</p>
      </div>
    );
  }

  const speaker = stripMd(current.character || '') || '(no speaker)';
  const hasNote = !!(current.direction && String(current.direction).trim());

  return (
    <div className="dialog-perform">
      <div className="dialog-perform-header">
        <span className="dialog-perform-progress">
          Line {safeIndex + 1} of {count}
        </span>
        <button
          type="button"
          className="dialog-perform-close"
          onClick={onClose}
          title="Close (Esc)"
        >
          ✕ Close
        </button>
      </div>

      <DialogContextStrip dialog={prev} kind="prev" />

      <div className="dialog-perform-direction">
        <div
          className="field-label"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>Direction</span>
          <button
            type="button"
            className="dialog-regen-btn"
            onClick={generateDirection}
            disabled={genDir}
            title="Generate a performance note: what's happening in the scene + how to play this line"
          >
            {genDir ? 'Generating…' : hasNote ? '↻ Regenerate note' : '✨ Generate note'}
          </button>
        </div>
        <CollabField
          field={`item:${id}:direction`}
          multiline
          placeholder="What's happening in the scene here + how to play this line…"
        />
        {genDirError && <div className="error-banner small">{genDirError}</div>}
      </div>

      <div className="dialog-perform-line">
        <div className="dialog-perform-speaker">{speaker}</div>
        <CollabField field={`item:${id}:body`} multiline placeholder="What the character says…" />
      </div>

      <DialogContextStrip dialog={next} kind="next" />

      <div className="dialog-perform-record">
        <AudioSlot
          audioId={current.audio_file_id}
          uploadEndpoint={`/dialog/${id}/audio`}
          deleteEndpoint={`/dialog/${id}/audio`}
          recordingPrefix={`dialog-${id}`}
          label="Your take"
          onRefresh={onAudioChange}
        />
      </div>

      <div className="dialog-perform-nav">
        <button type="button" onClick={() => go(-1)} disabled={safeIndex === 0}>
          ◀ Prev line
        </button>
        <button type="button" onClick={() => go(1)} disabled={safeIndex >= count - 1}>
          Next line ▶
        </button>
      </div>
    </div>
  );
}

// Local markdown stripper (matches the per-widget helpers used elsewhere).
function stripMd(s) {
  return String(s)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
