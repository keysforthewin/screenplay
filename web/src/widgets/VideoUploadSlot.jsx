import { useState } from 'react';
import { apiDelete, attachmentUrl } from '../api.js';
import { VideoPickerModal } from './VideoPickerModal.jsx';

// Source-video attachment widget. Mirrors AudioSlot but for video-to-video:
// users attach a clip that will be passed to v2v fal models as the input
// video. Distinct from the storyboard's generated video — that one lives at
// `video_file_id` and is set by the fal pipeline, not the user.
//
// The "+ Add video" / "Replace video" button opens VideoPickerModal which
// consolidates upload, webcam recording, and picking from any beat or
// character video attachment ("Reference").
//
// Props:
//   videoId         — GridFS attachments _id of the uploaded video, or null
//   uploadEndpoint  — POST URL (multipart with field `file`)
//   deleteEndpoint  — DELETE URL (clears the entity's video_upload_file_id)
//   storyboardId    — storyboard hex id, required for the Reference tab
//   label           — header label, defaults to "Video"
//   onRefresh       — called after every successful mutation
export function VideoUploadSlot({
  videoId,
  uploadEndpoint,
  deleteEndpoint,
  storyboardId = null,
  label = 'Video',
  onRefresh,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const url = attachmentUrl(videoId);

  async function remove() {
    if (!confirm('Remove uploaded video?')) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(deleteEndpoint);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const addLabel = url ? 'Replace video' : '+ Add video';

  return (
    <div className="storyboard-video-upload">
      <div className="storyboard-frame-label">{label}</div>
      {url && (
        <div className="storyboard-video-upload-row">
          <video
            controls
            src={url}
            preload="metadata"
            playsInline
            className="storyboard-video-upload-el"
          />
          <button type="button" disabled={busy} onClick={remove}>
            ×
          </button>
        </div>
      )}
      <div className="storyboard-video-upload-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => setPickerOpen(true)}
        >
          {addLabel}
        </button>
      </div>
      {error && <div className="error-banner small">{error}</div>}
      <VideoPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        uploadEndpoint={uploadEndpoint}
        recordingPrefix={storyboardId ? `scene-${storyboardId}` : 'recording'}
        storyboardId={storyboardId}
        onAttached={onRefresh}
      />
    </div>
  );
}
