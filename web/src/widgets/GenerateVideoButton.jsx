import { useState } from 'react';
import { GenerateVideoDialog } from './GenerateVideoDialog.jsx';

// Button injected into the storyboard scene's AudioSlot extraActions slot.
// Per-model input requirements are checked inside the dialog (once the user
// has picked a model) and re-validated server-side. The button itself is
// only disabled when an external `disabled` prop is set (e.g. job already
// running for the beat).
export function GenerateVideoButton({ sb, storyboardId, disabled, onRefresh }) {
  const [open, setOpen] = useState(false);
  const isUpdate = Boolean(sb?.video_file_id);
  const tooltip = isUpdate
    ? 'Re-generate the video for this scene'
    : 'Generate a video from this scene with fal.ai';

  return (
    <>
      <button type="button" disabled={disabled} title={tooltip} onClick={() => setOpen(true)}>
        {isUpdate ? '🎬 Re-generate video' : '🎬 Generate video'}
      </button>
      <GenerateVideoDialog
        open={open}
        onClose={() => setOpen(false)}
        storyboardId={storyboardId}
        sb={sb}
        onRefresh={onRefresh}
      />
    </>
  );
}
