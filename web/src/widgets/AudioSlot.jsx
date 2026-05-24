import { useState } from 'react';
import { apiDelete, attachmentUrl } from '../api.js';
import { AudioPickerModal } from './AudioPickerModal.jsx';

// Audio attachment widget. The "Add / Replace audio" button opens
// AudioPickerModal which consolidates upload, mic recording, picking from
// any beat/character audio attachment ("Reference"), and (for storyboard
// scenes) copying from an in-beat dialog item ("From dialog").
//
// Props:
//   audioId           — GridFS attachments _id or null
//   uploadEndpoint    — POST URL (multipart with field `file`)
//   deleteEndpoint    — DELETE URL (clears the entity's audio_file_id)
//   recordingPrefix   — base name for recorded files (e.g. `dialog-<id>`)
//   label             — header label, defaults to "Audio"
//   storyboardId      — storyboard hex id | null. If set, the picker
//                       shows a "Reference" tab listing project-wide
//                       audio attachments on beats and characters.
//   dialogPicker      — { storyboardId, beatId } | null — if set, the
//                       picker shows a "From dialog" tab that copies a
//                       dialog item's audio onto this scene.
//   onRefresh         — called after every successful mutation
//   extraActions      — optional ({ busy }) => ReactNode rendered alongside
//                       the Add/Replace button. Used for entity-specific
//                       buttons like "Generate video…".
export function AudioSlot({
  audioId,
  uploadEndpoint,
  deleteEndpoint,
  recordingPrefix = 'recording',
  label = 'Audio',
  storyboardId = null,
  dialogPicker = null,
  onRefresh,
  extraActions,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const url = attachmentUrl(audioId);

  async function remove() {
    if (!confirm('Remove audio?')) return;
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

  const addLabel = url ? 'Replace audio' : '+ Add audio';

  return (
    <div className="storyboard-audio">
      <div className="storyboard-frame-label">{label}</div>
      {url && (
        <div className="storyboard-audio-row">
          <audio controls src={url} preload="metadata" />
          <button type="button" disabled={busy} onClick={remove}>
            ×
          </button>
        </div>
      )}
      <div className="storyboard-audio-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => setPickerOpen(true)}
        >
          {addLabel}
        </button>
        {extraActions?.({ busy })}
      </div>
      {error && <div className="error-banner small">{error}</div>}
      <AudioPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        uploadEndpoint={uploadEndpoint}
        recordingPrefix={recordingPrefix}
        storyboardId={storyboardId}
        dialogPicker={dialogPicker}
        onAttached={onRefresh}
      />
    </div>
  );
}
