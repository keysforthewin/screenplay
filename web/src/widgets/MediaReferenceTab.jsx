import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../api.js';

// Shared "Reference" tab body for the storyboard Add Audio / Add Video
// dialogs. Lists every audio- or video-typed attachment owned by a beat or
// character anywhere in the project, with a substring filter on
// filename / owner name. Picking an item invokes `onPick(attachment_id)`,
// which the parent uses to call the appropriate from-attachment POST route.
export function MediaReferenceTab({ storyboardId, mediaType, busy, onPick }) {
  const [refs, setRefs] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!storyboardId || !mediaType) return undefined;
    let cancelled = false;
    setRefs(null);
    setLoadError(null);
    (async () => {
      try {
        const r = await apiGet(
          `/storyboard/${storyboardId}/media-references?type=${encodeURIComponent(mediaType)}`,
        );
        if (!cancelled) setRefs(r?.references || []);
      } catch (e) {
        if (!cancelled) setLoadError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storyboardId, mediaType]);

  const filtered = useMemo(() => {
    if (!refs) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return refs;
    return refs.filter((r) => {
      return (
        (r.filename || '').toLowerCase().includes(needle) ||
        (r.owner_name || '').toLowerCase().includes(needle)
      );
    });
  }, [refs, q]);

  if (loadError) {
    return <div className="error-banner small">{loadError}</div>;
  }
  if (refs === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  if (refs.length === 0) {
    return (
      <p className="ref-picker-empty">
        No {mediaType} attachments on any beats or characters yet. Upload one
        to a beat or character first to see it here.
      </p>
    );
  }

  return (
    <div>
      <input
        type="search"
        className="ref-picker-search"
        placeholder={`Filter ${mediaType} references…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {filtered.length === 0 ? (
        <p className="ref-picker-empty">No matches.</p>
      ) : (
        <div className="ref-picker-attachment-list">
          {filtered.map((r) => {
            const id =
              r.attachment_id?.toString?.() || String(r.attachment_id);
            const ownerLabel =
              r.owner_type === 'beat'
                ? r.owner_order != null
                  ? `Beat ${r.owner_order} · ${r.owner_name}`
                  : r.owner_name
                : `Character · ${r.owner_name}`;
            const size = formatSize(r.size);
            return (
              <button
                key={id}
                type="button"
                className="ref-picker-attachment-item"
                disabled={busy}
                onClick={() => onPick(id)}
              >
                <span style={{ fontSize: 20 }} aria-hidden="true">
                  {mediaType === 'video' ? '🎬' : '🔊'}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {r.filename || '(unnamed)'}
                  </div>
                  <div
                    style={{ color: 'var(--fg-muted)', fontSize: '0.85em' }}
                  >
                    {ownerLabel}
                    {size ? ` · ${size}` : ''}
                  </div>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
