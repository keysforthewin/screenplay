import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiDelete, apiPatchJson } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { useComfyAvailability, COMFY_DISABLED_MESSAGE } from './comfyControls.jsx';
import { GenerateVideoDialog } from './GenerateVideoDialog.jsx';
import { ComfyVideoDialog } from './ComfyVideoDialog.jsx';
import { isComfyJobActive, useComfyCutJobs } from './comfyCutJobs.jsx';
import { ClipVideoPanel } from './ClipVideoPanel.jsx';
import { CutBatchStatus, useCutVideoBatch } from './cutVideoBatch.jsx';
import { CutFramePanel } from './CutFramePanel.jsx';
import { CutKeyframes } from './CutKeyframes.jsx';

function readError(e) {
  let msg = e?.message || 'Update failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

// One cut: its name, length, the prompt for the video model, its start and
// end frames (with any keyframes between them), and the clip generated.
export function CutItem({ cut, label, beatId, disabled, onRefresh, onDelete }) {
  const comfyAvail = useComfyAvailability();
  const comfyOff = comfyAvail ? !comfyAvail.configured : false;
  const id = String(cut._id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [comfyOpen, setComfyOpen] = useState(false);
  const [falOpen, setFalOpen] = useState(false);
  const [durationDraft, setDurationDraft] = useState(null);

  const hasVideo = Boolean(cut.video_file_id);
  const framesReady = Boolean(cut.start_frame?.image_id && cut.end_frame?.image_id);
  const comfyJob = useComfyCutJobs()?.jobs?.[id] || null;
  const comfyActive = isComfyJobActive(comfyJob);
  // This cut's place in a running "Generate all videos" batch, if any.
  const batchItem = useCutVideoBatch()?.items?.[id] || null;
  const batchRendering = batchItem?.status === 'running';
  const comfyLabel = !comfyActive
    ? `${hasVideo ? 'Regenerate' : 'Generate'} video (ComfyUI)`
    : comfyJob.status === 'queued'
      ? `Queued${comfyJob.queue_position ? ` #${comfyJob.queue_position}` : ''} (ComfyUI)`
      : 'Rendering… (ComfyUI)';
  const needFrames = framesReady ? null : 'Generate the start frame and the end frame first';

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };

  async function call(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  function commitDuration() {
    if (durationDraft == null) return;
    const raw = String(durationDraft).trim();
    setDurationDraft(null);
    if (raw === '') {
      if (cut.duration_seconds != null) call(() => apiPatchJson(`/cut/${id}`, { duration_seconds: null }));
      return;
    }
    const n = Math.round(Number(raw) * 2) / 2;
    if (!Number.isFinite(n) || n < 0.5 || n > 60) {
      setError('Duration must be between 0.5 and 60 seconds.');
      return;
    }
    if (n !== cut.duration_seconds) call(() => apiPatchJson(`/cut/${id}`, { duration_seconds: n }));
  }

  return (
    <div ref={setNodeRef} style={style} className={`dialog-item video-prompt-item cut-item${batchRendering ? ' is-batch-rendering' : ''}`}>
      <div className="dialog-item-header">
        <button type="button" className="dialog-drag-handle" aria-label="Drag to reorder" {...attributes} {...listeners}>⋮⋮</button>
        <span className="video-prompt-index">{label}</span>
        <div className="video-prompt-title">
          <CollabField field={`item:${id}:title`} placeholder="Cut name…" />
        </div>
        <label className="video-prompt-duration" title="How long this cut runs, in seconds">
          <span className="field-label" style={{ margin: 0 }}>Duration</span>
          <input
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            value={durationDraft ?? (cut.duration_seconds ?? '')}
            disabled={busy || disabled}
            onChange={(e) => setDurationDraft(e.target.value)}
            onBlur={commitDuration}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            style={{ width: 64 }}
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>s</span>
        </label>
        {batchRendering ? <span className="spinner cut-batch-spinner" role="status" aria-label="Generating video" title="Generating video…" /> : null}
        <button type="button" className="danger" disabled={busy || disabled || comfyActive || batchRendering} onClick={onDelete}>Delete</button>
      </div>

      <div className="dialog-item-fields">
        {error ? <div className="error-banner small">{error}</div> : null}

        <CollabField label="Video prompt" field={`item:${id}:prompt`} multiline placeholder="What happens in this cut — the prompt the video model receives…" />

        <CutFramePanel cut={cut} frame="start" beatId={beatId} disabled={disabled} onRefresh={onRefresh} />
        <CutKeyframes cut={cut} beatId={beatId} disabled={disabled} onRefresh={onRefresh} />
        <CutFramePanel cut={cut} frame="end" beatId={beatId} disabled={disabled} onRefresh={onRefresh} />

        <div className="video-prompt-actions">
          <button
            type="button"
            className="primary"
            disabled={!comfyActive && (busy || disabled || comfyOff || !framesReady)}
            onClick={() => setComfyOpen(true)}
            title={comfyOff ? COMFY_DISABLED_MESSAGE : comfyActive ? "Show this render's progress" : needFrames || 'Generate this cut with a ComfyUI model'}
          >
            {comfyLabel}{comfyOff ? ' — disabled' : ''}
          </button>
          <button type="button" className={comfyOff ? 'primary' : ''} disabled={busy || disabled || !framesReady || batchRendering} onClick={() => setFalOpen(true)} title={needFrames || 'Generate this cut with a fal.ai model'}>
            {hasVideo ? 'Regenerate' : 'Generate'} video (fal.ai)
          </button>
          {hasVideo ? (
            <button
              type="button"
              className="danger"
              disabled={busy || disabled || comfyActive}
              onClick={() => {
                if (confirm('Discard the generated video for this cut?')) call(() => apiDelete(`/cut/${id}/video`));
              }}
            >
              Discard video
            </button>
          ) : null}
          {needFrames ? <span className="cut-video-hint">{needFrames}.</span> : null}
          <CutBatchStatus item={batchItem} />
        </div>

        <ClipVideoPanel sb={cut} />
      </div>

      <ComfyVideoDialog open={comfyOpen} onClose={() => setComfyOpen(false)} cut={cut} beatId={beatId} onRefresh={onRefresh} />
      <GenerateVideoDialog open={falOpen} onClose={() => setFalOpen(false)} storyboardId={id} sb={cut} onRefresh={onRefresh} promptField={`item:${id}:prompt`} />
    </div>
  );
}
