import { useState } from 'react';
import { apiDelete, imageUrl, thumbUrl } from '../api.js';

// Read-only thumbnail strip for the References tab. Surfaces GridFS images
// owned by the host entity that aren't part of the embedded images[] array —
// typically storyboard frames and per-frame reference uploads.
//
// Each thumb is a click-to-open-in-new-tab anchor with a small trash-can
// overlay button. The trash button calls `DELETE ${deletePath(id)}` which
// must drop the GridFS bytes (and any related references) — see
// /beat/:id/orphan-image/:imageId and the character counterpart.
export function ReferenceExtrasSection({ items, deletePath, onChange, emptyText }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  async function onDelete(id) {
    if (!deletePath) return;
    setBusyId(id);
    setError(null);
    try {
      await apiDelete(deletePath(id));
      await onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  }

  if (!items || items.length === 0) {
    if (emptyText) {
      return <p style={{ color: 'var(--fg-muted)' }}>{emptyText}</p>;
    }
    return null;
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <div className="ref-picker-grid">
        {items.map((img) => {
          const id = img._id?.toString?.() || String(img._id);
          const label = img.name || img.filename || '';
          const busy = busyId === id;
          return (
            <div
              key={id}
              className="ref-picker-thumb"
              style={{ position: 'relative', cursor: 'default' }}
            >
              <a
                href={imageUrl(id)}
                target="_blank"
                rel="noreferrer"
                title={label || 'Open full size in new tab'}
                style={{ display: 'block', height: '100%' }}
              >
                <img src={thumbUrl(id)} alt={label} loading="lazy" />
              </a>
              {deletePath && (
                <button
                  type="button"
                  onClick={() => onDelete(id)}
                  disabled={busy}
                  title="Delete image"
                  aria-label="Delete image"
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    width: 24,
                    height: 24,
                    padding: 0,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'rgba(0, 0, 0, 0.6)',
                    color: '#fff',
                    fontSize: 14,
                    lineHeight: 1,
                    cursor: busy ? 'progress' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {busy ? '…' : '🗑'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
