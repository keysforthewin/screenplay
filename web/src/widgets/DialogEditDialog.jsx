import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiPostJson } from '../api.js';

// Quick-and-dirty markdown stripper for the in-modal preview list.
function previewLine(s) {
  if (!s) return '';
  return String(s)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function DialogEditDialog({ open, items, beatId, onClose, onApplied }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [details, setDetails] = useState(null);
  const [notice, setNotice] = useState(null);

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
      const result = await apiPostJson('/dialogs/edit', {
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
      title="Edit dialog with instructions"
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
        Reference items by number. Claude can rewrite a line, change the
        speaker, reorder, add new lines, or delete lines.
      </p>
      {items?.length > 0 ? (
        <ol className="storyboard-edit-current">
          {items.map((d, i) => {
            const speaker = previewLine(d.character) || '(no speaker)';
            const body = previewLine(d.body) || '(empty)';
            return (
              <li key={d._id?.toString?.() || String(d._id)}>
                <span className="num">#{i + 1}</span>
                <strong>{speaker}:</strong> {body}
              </li>
            );
          })}
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
        placeholder="e.g. Combine #2 and #3 into one line spoken by Alice, delete #4, add a closing line at the end where Bob agrees."
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
