// The assembled beat video, above the shot list. Discard keeps the shot clips.
import { useState } from 'react';
import { apiDelete, attachmentUrl } from '../api.js';

export function BeatVideoPanel({ beat, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const id = beat?.video_file_id ? (beat.video_file_id.toString?.() || String(beat.video_file_id)) : null;
  if (!id) return null;
  const src = attachmentUrl(id);
  const dur = Number(beat.video_duration_seconds);
  const when = beat.video_generated_at ? new Date(beat.video_generated_at) : null;

  async function discard() {
    if (!confirm('Discard the beat video? The individual shot clips are kept.')) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/beat/${beat._id}/video`);
      await onRefresh?.();
    } catch (e) {
      setError(e.message || 'Failed to discard.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beat-video-panel">
      <div className="beat-video-head">
        <strong>Beat video</strong>
        <span className="beat-video-meta">
          {Number.isFinite(dur) && dur > 0 ? `${Math.round(dur)}s` : ''}
          {when && !Number.isNaN(when.getTime()) ? ` · ${when.toLocaleString()}` : ''}
        </span>
        <a href={src} download className="beat-video-download">Download</a>
        <button type="button" className="danger" disabled={busy} onClick={discard}>Discard beat video</button>
      </div>
      <video controls src={src} preload="metadata" className="beat-video-el" />
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}
