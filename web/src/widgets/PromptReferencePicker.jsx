import { useEffect, useMemo, useState } from 'react';
import { apiGet, thumbUrl } from '../api.js';
import { Modal } from './Modal.jsx';

// Picker for a Prompts-tab row's reference images. Offers exactly the
// catalog the auto-generator picks from (GET /video-prompts/candidates: the
// ARTWORK of the beat's characters and sets — done artworks only, never
// uploaded portraits, sheets or gallery images), grouped by owner. Multi-pick;
// the chosen ids are APPENDED to the row's ordered list in the order they
// were clicked, so the next @ImageN handle is predictable.
export function PromptReferencePicker({ open, beatId, existingIds, maxTotal, onClose, onPick }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState([]);

  useEffect(() => {
    if (!open) return;
    setPicked([]);
    setError(null);
    let cancelled = false;
    apiGet(`/video-prompts/candidates?beat_id=${encodeURIComponent(beatId)}`)
      .then((r) => {
        if (!cancelled) setCatalog(r.candidates || []);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, beatId]);

  const existing = useMemo(() => new Set((existingIds || []).map(String)), [existingIds]);
  const remaining = Math.max(0, (maxTotal || 9) - existing.size);

  const groups = useMemo(() => {
    const map = new Map();
    for (const e of catalog || []) {
      const key = `${e.owner_type}:${e.owner_name}`;
      if (!map.has(key)) map.set(key, { owner_type: e.owner_type, owner_name: e.owner_name, items: [] });
      map.get(key).items.push(e);
    }
    return [...map.values()];
  }, [catalog]);

  function toggle(id) {
    if (existing.has(id)) return;
    setPicked((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= remaining) return cur;
      return [...cur, id];
    });
  }

  return (
    <Modal
      open={open}
      title="Add reference images (artwork)"
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!picked.length}
            onClick={() => onPick(picked)}
          >
            Add {picked.length ? `${picked.length} ` : ''}as @Image{existing.size + 1}
            {picked.length > 1 ? `–@Image${existing.size + picked.length}` : ''}
          </button>
        </>
      }
    >
      {error && <div className="error-banner">{error}</div>}
      {!catalog && !error ? (
        <p style={{ color: 'var(--fg-muted)' }}>Loading…</p>
      ) : null}
      {catalog && !catalog.length ? (
        <p style={{ color: 'var(--fg-muted)' }}>
          No artwork available. Generate or import artwork on this beat's characters and
          sets first — only the Artwork section is offered here.
        </p>
      ) : null}
      {remaining === 0 ? (
        <p style={{ color: '#ffb86b', fontSize: 13 }}>
          This prompt already has the maximum of {maxTotal || 9} reference images.
        </p>
      ) : null}
      {groups.map((g) => (
        <section key={`${g.owner_type}:${g.owner_name}`} style={{ marginBottom: 14 }}>
          <div className="field-label" style={{ marginBottom: 6 }}>
            {g.owner_type === 'set' ? 'Set' : 'Character'} · {g.owner_name}
          </div>
          <div className="video-prompt-picker-grid">
            {g.items.map((e) => {
              const id = String(e.image_id);
              const isExisting = existing.has(id);
              const idx = picked.indexOf(id);
              return (
                <button
                  type="button"
                  key={id}
                  className={
                    'video-prompt-picker-cell' +
                    (isExisting ? ' is-existing' : '') +
                    (idx >= 0 ? ' is-picked' : '')
                  }
                  title={[e.label, e.description].filter(Boolean).join(' — ')}
                  disabled={isExisting}
                  onClick={() => toggle(id)}
                >
                  <img src={thumbUrl(id)} alt={e.label} loading="lazy" />
                  <span className="video-prompt-picker-label">{e.label.replace(`${g.owner_name} — `, '')}</span>
                  {isExisting ? <span className="video-prompt-picker-badge">added</span> : null}
                  {idx >= 0 ? (
                    <span className="video-prompt-picker-badge is-picked">@Image{existing.size + idx + 1}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </Modal>
  );
}
