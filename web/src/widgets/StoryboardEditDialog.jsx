import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiPostJson } from '../api.js';

// Quick-and-dirty markdown stripper for the in-modal preview list. Removes
// bold/italic markers, headings, and link syntax. Doesn't need to be perfect
// — it's just so the numbered list doesn't show literal asterisks.
function previewLine(s) {
  if (!s) return '(empty)';
  return String(s)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim() || '(empty)';
}

export function StoryboardEditDialog({ open, items, beatId, onClose, onApplied }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState(null);
  const [notice, setNotice] = useState(null);

  // Reset state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setText('');
      setBusy(false);
      setError(null);
      setDetails(null);
      setNotice(null);
    }
  }, [open]);

  async function submit() {
    setBusy(true);
    setError(null);
    setDetails(null);
    setNotice(null);
    try {
      const result = await apiPostJson('/storyboards/edit', {
        beat_id: String(beatId),
        instructions: text,
      });
      const total =
        (result.ops_applied?.add || 0) +
        (result.ops_applied?.update || 0) +
        (result.ops_applied?.move || 0) +
        (result.ops_applied?.delete || 0);
      if (total === 0) {
        setNotice(result.message || 'No changes were proposed. Try a more specific instruction.');
        setBusy(false);
        return;
      }
      setBusy(false);
      onApplied?.(result);
    } catch (e) {
      setBusy(false);
      // apiPostJson throws an Error whose message is the raw response body.
      // Try parsing it as JSON to recover the validation details list.
      let parsed = null;
      try { parsed = JSON.parse(e.message); } catch { /* not JSON */ }
      if (parsed && Array.isArray(parsed.details)) {
        setError(parsed.error || 'Some operations were invalid.');
        setDetails(parsed.details);
      } else if (parsed && parsed.error) {
        setError(parsed.error);
      } else {
        setError(e.message || String(e));
      }
    }
  }

  return (
    <Modal
      open={open}
      title="Edit storyboard with instructions"
      onClose={busy ? () => {} : onClose}
      dismissible={!busy}
      footer={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="primary"
            onClick={submit}
            disabled={busy || !text.trim()}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </>
      }
    >
      <p className="modal-help">
        Reference items by number. Claude will adjust descriptions, reorder,
        add, or delete items. Existing frame images are preserved on items
        whose descriptions you change; new items have no images yet.
      </p>
      {items?.length > 0 ? (
        <ol className="storyboard-edit-current">
          {items.map((sb, i) => (
            <li key={sb._id?.toString?.() || String(sb._id)}>
              <span className="num">#{i + 1}</span>
              {previewLine(sb.text_prompt)}
            </li>
          ))}
        </ol>
      ) : (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 12px' }}>
          (No items yet. You can ask Claude to add some.)
        </p>
      )}
      <textarea
        className="storyboard-edit-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Move #3 before #1, delete #4, add an item at the end where Lily picks up the phone."
        disabled={busy}
      />
      {error && (
        <div className="error-banner small" style={{ marginTop: 12 }}>
          {error}
          {details && (
            <ul className="storyboard-edit-details">
              {details.map((d, i) => (
                <li key={i}>
                  <code>{d.op}</code>: {d.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {notice && (
        <div className="notice-banner" style={{ marginTop: 12 }}>
          {notice}
        </div>
      )}
    </Modal>
  );
}
