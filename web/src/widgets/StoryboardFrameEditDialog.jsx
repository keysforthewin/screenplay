import { useEffect, useRef, useState } from 'react';
import { InlineImageEditDialog } from './InlineImageEditDialog.jsx';
import { ReferencePickerModal } from './ReferencePickerModal.jsx';
import { apiGet, apiPostJson } from '../api.js';

const MODEL_STORAGE_KEY = 'screenplay.storyboardFrameEdit.model';
const POLL_INTERVAL_MS = 2000;

// In-line storyboard frame editor. Wraps InlineImageEditDialog and routes the
// apply/undo callbacks at the per-frame edit/undo endpoints.
//
// The edit route returns 202 + job_id; the wrapper polls
// /storyboard/frame-generate/job/:jobId until the job lands or fails and
// surfaces the right `status` / `errorMessage` props to the inner dialog so
// the spinner stays up while the image renders.
//
// References are one-shot per edit — not persisted on the storyboard's
// frame reference list. The ReferencePickerModal is used in ephemeral mode
// (the new `onApply` prop bypasses /reference/set).
//
// Props:
//   open, onClose, onDone (refresh callback for the parent storyboard list)
//   storyboardId          24-hex string
//   beatId                24-hex string (for the picker's tabs)
//   charactersInScene     forwarded to the picker
//   role                  'start_frame' | 'end_frame'
//   imageId               current frame image GridFS id (or null)
//   hasUndo               whether previous_*_frame_id is set
export function StoryboardFrameEditDialog({
  open,
  onClose,
  onDone,
  storyboardId,
  beatId,
  charactersInScene,
  role,
  imageId,
  hasUndo,
}) {
  const [jobId, setJobId] = useState(null);
  const [jobError, setJobError] = useState(null);
  const pollRef = useRef(null);
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  useEffect(() => {
    if (!open) {
      stopPolling();
      setJobId(null);
      setJobError(null);
      return;
    }
    setReferenceIds([]);
    setPickerOpen(false);
    return () => stopPolling();
  }, [open]);

  // When the frame's image id changes (the parent refreshed with a new image)
  // and a job was in flight, clear it — the new image is the result we were
  // waiting for. This drives `status` back to 'done' so the spinner clears.
  useEffect(() => {
    if (jobId && imageId) {
      stopPolling();
      setJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  async function pollJob(id) {
    try {
      const r = await apiGet(`/storyboard/frame-generate/job/${id}`);
      const job = r?.job;
      if (!job) return;
      if (job.status === 'done') {
        stopPolling();
        await onDone?.();
      } else if (job.status === 'error') {
        stopPolling();
        setJobError(job.error || 'Edit failed.');
        setJobId(null);
      }
    } catch {
      // Transient 404s while the job is being registered, or network blips —
      // ignored, next tick retries.
    }
  }

  async function applyEdit({ prompt, model, referenceIds: refs }) {
    setJobError(null);
    const r = await apiPostJson(
      `/storyboard/${storyboardId}/frame/${role}/edit`,
      {
        prompt,
        model,
        reference_image_ids: Array.isArray(refs) ? refs : [],
      },
    );
    const id = r?.job_id;
    if (!id) throw new Error('Server did not return a job id.');
    setJobId(id);
    setReferenceIds([]);
    stopPolling();
    pollRef.current = setInterval(() => pollJob(id), POLL_INTERVAL_MS);
    pollJob(id);
  }

  async function undoEdit() {
    await apiPostJson(
      `/storyboard/${storyboardId}/frame/${role}/undo`,
      {},
    );
  }

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }

  const status = jobError ? 'error' : jobId ? 'pending' : 'done';
  const label = role === 'start_frame' ? 'start frame' : 'end frame';

  return (
    <>
      <InlineImageEditDialog
        open={open}
        onClose={onClose}
        onDone={onDone}
        title={`Edit ${label}`}
        imageId={imageId}
        status={status}
        errorMessage={jobError}
        hasUndo={hasUndo}
        applyEdit={storyboardId ? applyEdit : null}
        undoEdit={storyboardId ? undoEdit : null}
        modelStorageKey={MODEL_STORAGE_KEY}
        referenceIds={referenceIds}
        onPickReferences={() => setPickerOpen(true)}
        onRemoveReference={removeReference}
      />
      <ReferencePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        sbId={storyboardId}
        beatId={beatId}
        charactersInScene={charactersInScene}
        currentReferenceIds={referenceIds}
        role="reference"
        onApply={(ids) => setReferenceIds(ids)}
      />
    </>
  );
}
