import { useState } from 'react';
import { GenerateVideoDialog } from './GenerateVideoDialog.jsx';

// Button injected into the storyboard scene's AudioSlot extraActions slot.
// Disabled with an explanatory tooltip when any of the four required inputs
// (start frame, end frame, character sheet, audio) is missing.
export function GenerateVideoButton({ sb, storyboardId, disabled, onRefresh }) {
  const [open, setOpen] = useState(false);

  const missing = [];
  if (!sb?.start_frame_id) missing.push('start frame');
  if (!sb?.end_frame_id) missing.push('end frame');
  if (!sb?.character_sheet_image_id) missing.push('character sheet');
  if (!sb?.audio_file_id) missing.push('audio');

  const ready = missing.length === 0;
  const isUpdate = Boolean(sb?.video_file_id);
  const tooltip = ready
    ? isUpdate
      ? 'Re-generate the video for this scene with Wan 2.7'
      : 'Generate a Wan 2.7 video from this scene\'s frames + audio'
    : `Need: ${missing.join(', ')}`;

  return (
    <>
      <button
        type="button"
        disabled={disabled || !ready}
        title={tooltip}
        onClick={() => setOpen(true)}
      >
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
