import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPatchJson, apiPostJson, thumbUrl } from '../api.js';
import { SetSelect } from './SetSelect.jsx';

function plainOf(s) {
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

export function BeatSets({ beat, toc, onRefresh }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState(null);

  const linkedNames = useMemo(() => beat.sets || [], [beat.sets]);

  const tocByPlain = useMemo(() => {
    const map = new Map();
    for (const s of toc?.sets || []) {
      const key = (s.plain_name || plainOf(s.name)).toLowerCase();
      if (key) map.set(key, s);
    }
    return map;
  }, [toc]);

  const linked = useMemo(() => {
    return linkedNames.map((raw) => {
      const plain = plainOf(raw);
      const tocEntry = tocByPlain.get(plain.toLowerCase());
      return { raw, plain, tocEntry };
    });
  }, [linkedNames, tocByPlain]);

  const totalInScreenplay = (toc?.sets || []).length;
  const countLabel = `${linked.length} of ${totalInScreenplay} set${
    totalInScreenplay === 1 ? '' : 's'
  } in this beat`;
  const countLine = (
    <div
      className="beat-set-count"
      style={{ color: 'var(--fg-muted)', fontSize: '0.9em', margin: '4px 0' }}
    >
      {countLabel}
    </div>
  );

  const linkedKeys = useMemo(() => {
    return new Set(linked.map((l) => l.plain.toLowerCase()).filter(Boolean));
  }, [linked]);

  const pickerOptions = useMemo(() => {
    return (toc?.sets || []).filter(
      (s) => !linkedKeys.has((s.plain_name || plainOf(s.name)).toLowerCase()),
    );
  }, [toc, linkedKeys]);

  async function patchSets(nextNames) {
    setBusy(true);
    setError(null);
    try {
      await apiPatchJson(`/beat/${beat._id}`, { sets: nextNames });
      await onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink(rawName) {
    if (!confirm(`Unlink ${plainOf(rawName) || rawName} from this beat?`)) return;
    const next = linkedNames.filter((n) => n !== rawName);
    await patchSets(next);
  }

  async function addByPlain(plain) {
    if (!plain) return;
    const next = [...linkedNames, plain];
    await patchSets(next);
    setPickerKey((k) => k + 1);
  }

  async function createSet(e) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const r = await apiPostJson('/set', { name: trimmed });
      await addByPlain(r.set.name);
      setNewName('');
      setCreating(false);
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {countLine}
      {linked.length === 0 && (
        <p style={{ color: 'var(--fg-muted)', margin: '4px 0 12px' }}>
          No sets linked yet.
        </p>
      )}
      <div className="beat-set-list">
        {linked.map(({ raw, plain, tocEntry }) => {
          const linkPath = tocEntry?._id
            ? `/set/${tocEntry._id}`
            : `/set/${encodeURIComponent(plain || raw)}`;
          const thumbId = tocEntry?.main_image_id;
          const thumbStr = thumbId?.toString
            ? thumbId.toString()
            : typeof thumbId === 'string'
              ? thumbId
              : null;
          return (
            <div key={raw} className="beat-set-row">
              <div className="beat-set-thumb">
                {thumbStr ? (
                  <img src={thumbUrl(thumbStr)} alt={plain || raw} loading="lazy" />
                ) : (
                  <div className="beat-set-thumb-placeholder" aria-hidden="true">
                    🏙️
                  </div>
                )}
              </div>
              <div className="beat-set-name">
                {tocEntry ? (
                  <Link to={linkPath}>{plain || raw}</Link>
                ) : (
                  <span style={{ color: 'var(--fg-muted)' }}>
                    {plain || raw} <em>(missing)</em>
                  </span>
                )}
              </div>
              <div className="beat-set-actions">
                {tocEntry && (
                  <Link className="icon-link" to={linkPath}>
                    Open
                  </Link>
                )}
                <button onClick={() => unlink(raw)} disabled={busy}>
                  Unlink
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="beat-set-add">
        <SetSelect
          key={pickerKey}
          value=""
          sets={pickerOptions}
          disabled={busy}
          onChange={addByPlain}
        />
        {!creating ? (
          <button
            type="button"
            className="beat-set-new-btn"
            onClick={() => { setCreating(true); setCreateError(null); }}
            disabled={busy}
          >
            + New set
          </button>
        ) : (
          <form className="beat-set-create" onSubmit={createSet}>
            <input
              type="text"
              autoFocus
              placeholder="New set name…"
              value={newName}
              disabled={createBusy}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="submit" className="primary" disabled={createBusy || !newName.trim()}>
              {createBusy ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => { setCreating(false); setNewName(''); setCreateError(null); }}
              disabled={createBusy}
            >
              Cancel
            </button>
          </form>
        )}
        {createError && <div className="error-banner small">{createError}</div>}
      </div>
      {countLine}
    </div>
  );
}
