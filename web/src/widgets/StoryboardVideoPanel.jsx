import { useState } from 'react';
import { apiDelete, attachmentUrl } from '../api.js';

// Inline video player for a storyboard scene. Renders below the Audio
// section when sb.video_file_id is set. Falls back to nothing when there's
// no video — the entry-point button lives in AudioSlot's extraActions.
export function StoryboardVideoPanel({ sb, storyboardId, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!sb?.video_file_id) return null;

  const id = sb.video_file_id?.toString?.() || String(sb.video_file_id);
  const src = attachmentUrl(id);

  async function discard() {
    if (!confirm('Discard this generated video? The MP4 will be deleted.')) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/storyboard/${storyboardId}/video`);
      await onRefresh?.();
    } catch (e) {
      setError(e.message || 'Failed to discard video.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="storyboard-video" style={{ marginBottom: 12 }}>
      <div className="storyboard-frame-label">Generated video</div>
      <video
        controls
        src={src}
        preload="metadata"
        style={{
          width: '100%',
          maxHeight: 360,
          background: '#000',
          borderRadius: 4,
          marginTop: 4,
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
        {sb.video_duration_seconds ? (
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {sb.video_duration_seconds}s
          </span>
        ) : null}
        <button type="button" disabled={busy} onClick={discard}>
          Discard video
        </button>
      </div>
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}
