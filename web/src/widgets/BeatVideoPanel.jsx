// An assembled video with download + discard: a scene MP4 (entity = scene,
// prefix 'video') or the beat MP4 (prefix 'prompts_video'). Discard keeps the
// individual clips.
import { useState } from 'react';
import { apiDelete, attachmentUrl } from '../api.js';

export function BeatVideoPanel({
  beat,
  entity,
  onRefresh,
  prefix = 'video',
  title = 'Beat video',
  deletePath = null,
  clipNoun = 'shot',
  className = '',
}) {
  const row = entity || beat;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const raw = row?.[`${prefix}_file_id`];
  const id = raw ? (raw.toString?.() || String(raw)) : null;
  if (!id) return null;
  const src = attachmentUrl(id);
  const dur = Number(row[`${prefix}_duration_seconds`]);
  const whenRaw = row[`${prefix}_generated_at`];
  const when = whenRaw ? new Date(whenRaw) : null;
  const path = deletePath || `/beat/${row._id}/video`;

  async function discard() {
    if (!confirm(`Discard the ${title.toLowerCase()}? The individual ${clipNoun} clips are kept.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(path);
      await onRefresh?.();
    } catch (e) {
      setError(e.message || 'Failed to discard.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`beat-video-panel ${className}`.trim()}>
      <div className="beat-video-head">
        <strong>{title}</strong>
        <span className="beat-video-meta">
          {Number.isFinite(dur) && dur > 0 ? `${Math.round(dur)}s` : ''}
          {when && !Number.isNaN(when.getTime()) ? ` · ${when.toLocaleString()}` : ''}
        </span>
        <a href={src} download className="beat-video-download">Download</a>
        <button type="button" className="danger" disabled={busy} onClick={discard}>Discard {title.toLowerCase()}</button>
      </div>
      <video controls src={src} preload="metadata" className="beat-video-el" />
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}
