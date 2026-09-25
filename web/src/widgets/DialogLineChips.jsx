// Which dialogue lines a shot covers. Rendered as removable pills (in script
// order) plus a native <select> to add an unassigned line. The planner fills
// this automatically (dialog_lines → dialog_ids); the chips exist so a human
// can fix a coverage warning without re-planning.
//
// Props:
//   value    — string[]   storyboard.dialog_ids (hex strings or ObjectIds)
//   dialogs  — array      the beat's dialog rows from GET /api/dialogs?beat_id=
//   disabled — boolean
//   onChange — async (nextIds: string[]) => …
import { useMemo, useState } from 'react';

export function dialogLineLabel(d, n) {
  const who = stripMd(d?.character || '').trim() || '—';
  const words = stripMd(d?.body || '').trim();
  const short = words.length > 28 ? `${words.slice(0, 28).trimEnd()}…` : words;
  return `#${n} ${who}${short ? `: ${short}` : ''}`;
}

export function DialogLineChips({ value, dialogs, disabled, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ids = useMemo(
    () => (Array.isArray(value) ? value : []).map((x) => x?.toString?.() || String(x)),
    [value],
  );
  // Line numbers follow list position (matches the planner's numbering).
  const byId = useMemo(() => {
    const m = new Map();
    (dialogs || []).forEach((d, i) => m.set(d._id?.toString?.() || String(d._id), { d, n: i + 1 }));
    return m;
  }, [dialogs]);
  const assigned = ids.map((id) => ({ id, ...(byId.get(id) || {}) }));
  const available = (dialogs || [])
    .map((d, i) => ({ id: d._id?.toString?.() || String(d._id), d, n: i + 1 }))
    .filter((x) => !ids.includes(x.id) && stripMd(x.d.body || '').trim());

  async function commit(next) {
    setBusy(true);
    setError(null);
    try {
      await onChange?.(next);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function add(id) {
    if (!id || ids.includes(id)) return;
    // Keep script order regardless of the order the user clicked.
    const next = [...ids, id].sort((a, b) => (byId.get(a)?.n || 0) - (byId.get(b)?.n || 0));
    commit(next);
  }

  if (!dialogs || dialogs.length === 0) return null;

  return (
    <span className="storyboard-chars-tags storyboard-dialog-chips" title="Dialogue lines this shot covers (lip-sync uses their recordings)">
      {assigned.map(({ id, d, n }) => (
        <span className="storyboard-char-tag storyboard-dialog-chip" key={id}>
          <span className="storyboard-char-tag-label">
            {d ? dialogLineLabel(d, n) : 'unknown line'}
            {d?.audio_file_id ? <span className="storyboard-dialog-chip-mic" title="Recorded"> 🎙</span> : null}
          </span>
          <button
            type="button"
            className="storyboard-char-tag-remove"
            aria-label="Unassign line"
            title="Unassign this line from the shot"
            disabled={disabled || busy}
            onClick={() => commit(ids.filter((x) => x !== id))}
          >
            ×
          </button>
        </span>
      ))}
      {available.length > 0 && (
        <select
          className="storyboard-dialog-chip-add"
          value=""
          disabled={disabled || busy}
          aria-label="Assign a dialogue line to this shot"
          onChange={(e) => add(e.target.value)}
        >
          <option value="">+ line…</option>
          {available.map(({ id, d, n }) => (
            <option key={id} value={id}>
              {dialogLineLabel(d, n)}{d.audio_file_id ? ' 🎙' : ''}
            </option>
          ))}
        </select>
      )}
      {error && <span className="error-banner small">{error}</span>}
    </span>
  );
}

function stripMd(s) {
  return String(s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ');
}
