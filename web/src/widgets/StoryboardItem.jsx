import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  apiDelete,
  apiGet,
  apiPatchJson,
  apiPostJson,
  imageUrl,
  thumbUrl,
} from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { FrameRegenerateDialog } from './FrameRegenerateDialog.jsx';
import { ReferencePickerModal } from './ReferencePickerModal.jsx';
import { ImageLightbox } from './ImageLightbox.jsx';
import { AudioSlot } from './AudioSlot.jsx';
import { GenerateVideoButton } from './GenerateVideoButton.jsx';
import { StoryboardVideoPanel } from './StoryboardVideoPanel.jsx';
import {
  SHOT_TYPES,
  durationCapFor,
  shotTypeLabel,
} from '../shotTypes.js';

// Frame slot that supports replace via file picker, delete, and (for
// generatable roles) nano-banana regeneration from the row's text_prompt.
// `generatable` is true for start_frame / end_frame and false for
// character_sheet (which is a manual reference, not a generated frame).
// Editable shot metadata row shown above the frames. The shot_type select
// drives the duration input's max attribute (and triggers a server-side
// re-clamp on the save). Duration is debounced via local state + onBlur so
// each keystroke isn't a PATCH.
function ShotMetaRow({ sb, sbId, onRefresh }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [durationLocal, setDurationLocal] = useState(
    sb.duration_seconds ?? '',
  );
  // Sync from props when the row refetches (e.g. after a server clamp).
  useEffect(() => {
    setDurationLocal(sb.duration_seconds ?? '');
  }, [sb.duration_seconds]);

  async function patch(body) {
    setBusy(true);
    setError(null);
    try {
      await apiPatchJson(`/storyboard/${sbId}`, body);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function commitDuration() {
    const trimmed = String(durationLocal).trim();
    if (trimmed === '') {
      if (sb.duration_seconds != null) patch({ duration_seconds: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) {
      // Reset to last-known-good and surface the error inline.
      setDurationLocal(sb.duration_seconds ?? '');
      setError('Duration must be a positive number.');
      return;
    }
    if (n === sb.duration_seconds) return;
    patch({ duration_seconds: Math.round(n) });
  }

  const cap = durationCapFor(sb.shot_type);

  return (
    <div className="storyboard-meta-row">
      <select
        value={sb.shot_type || ''}
        disabled={busy}
        aria-label="Shot type"
        onChange={(e) => patch({ shot_type: e.target.value || null })}
      >
        <option value="">— shot type —</option>
        {SHOT_TYPES.map((t) => (
          <option key={t} value={t}>
            {shotTypeLabel(t)}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={1}
        max={cap}
        step={1}
        disabled={busy}
        value={durationLocal}
        placeholder="—"
        aria-label="Duration in seconds"
        title={`Cap for ${shotTypeLabel(sb.shot_type) || 'this shot'}: ${cap}s`}
        onChange={(e) => setDurationLocal(e.target.value)}
        onBlur={commitDuration}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      <span className="storyboard-meta-suffix">s</span>
      {sb.characters_in_scene?.length > 0 && (
        <span className="storyboard-chars-badge">
          {sb.characters_in_scene.join(' · ')}
        </span>
      )}
      {error && <span className="error-banner small">{error}</span>}
    </div>
  );
}

function FrameSlot({
  label,
  role,
  imageId,
  sbId,
  beatId,
  charactersInScene,
  generatable,
  onRefresh,
  onOpenLightbox,
  prevSb,
}) {
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState(null);
  const [error, setError] = useState(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pollRef = useRef(null);
  const url = imageUrl(imageId);
  const thumbSrc = thumbUrl(imageId);
  const canGrab = role === 'start_frame' && prevSb != null;

  // Stop any in-flight poll on unmount so we don't setState on a dead
  // component. The job keeps running server-side regardless; the image still
  // lands via the fields_updated broadcast.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  async function remove() {
    if (!confirm(`Remove ${label}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/storyboard/${sbId}/image/${role}`);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function grabFromPrevious() {
    if (!canGrab) return;
    setBusy(true);
    setBusyLabel('Grabbing…');
    setError(null);
    try {
      await apiPostJson(`/storyboard/${sbId}/grab-start-frame-from-previous`, {});
      await onRefresh?.();
    } catch (err) {
      // Server bodies are JSON `{ error: '...' }`. The api helper rethrows the
      // raw body string, so parse it to pick out the friendly explanation.
      let serverMsg = err.message || '';
      try {
        const parsed = JSON.parse(serverMsg);
        if (parsed && typeof parsed.error === 'string') serverMsg = parsed.error;
      } catch {
        // not JSON; leave as-is.
      }
      if (serverMsg === 'previous shot has no generated video') {
        setError(
          'The previous storyboard item must have a generated video before you can grab its last frame.',
        );
      } else {
        setError(serverMsg || 'Grab failed.');
      }
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollFrameJob(jobId) {
    try {
      const r = await apiGet(`/storyboard/frame-generate/job/${jobId}`);
      const job = r?.job;
      if (!job) return;
      if (job.status === 'done') {
        stopPolling();
        await onRefresh?.();
        setBusy(false);
        setBusyLabel(null);
      } else if (job.status === 'error') {
        stopPolling();
        setError(job.error || 'Generation failed.');
        setBusy(false);
        setBusyLabel(null);
      }
    } catch {
      // Transient errors (404 while the job is still being registered,
      // network blips) are ignored; the next tick retries.
    }
  }

  async function submitRegen({
    mode,
    imageModel,
    editPrompt,
    customPrompt,
    promptOverride,
    includeContinuity,
    includeStartFrame,
  }) {
    setRegenOpen(false);
    setBusy(true);
    setBusyLabel(mode === 'edit' ? 'Editing…' : 'Generating…');
    setError(null);
    try {
      const body = { image_model: imageModel, mode };
      if (mode === 'edit') body.edit_prompt = editPrompt;
      if (mode === 'custom') body.custom_prompt = customPrompt;
      if (mode === 'full' && promptOverride) body.prompt_override = promptOverride;
      if (mode === 'full') {
        body.include_continuity = includeContinuity !== false;
        body.include_start_frame = includeStartFrame !== false;
      }
      const r = await apiPostJson(
        `/storyboard/${sbId}/frame/${role}/generate`,
        body,
      );
      const jobId = r?.job_id;
      if (!jobId) {
        throw new Error('Server did not return a job id.');
      }
      stopPolling();
      pollRef.current = setInterval(() => pollFrameJob(jobId), 2000);
      pollFrameJob(jobId);
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setBusyLabel(null);
    }
  }

  return (
    <div className="storyboard-frame">
      <div className="storyboard-frame-label">{label}</div>
      {url ? (
        <div className="storyboard-frame-img-wrap">
          <img
            src={thumbSrc}
            alt={label}
            loading="lazy"
            onClick={() => onOpenLightbox?.(url, label)}
          />
          <button
            type="button"
            className="storyboard-frame-remove"
            title={`Remove ${label}`}
            disabled={busy}
            onClick={remove}
          >
            ×
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="storyboard-frame-empty"
          disabled={busy}
          onClick={() => setPickerOpen(true)}
        >
          {busyLabel || '+ Add'}
        </button>
      )}
      <div className="storyboard-frame-actions">
        <button
          type="button"
          className="storyboard-frame-replace"
          disabled={busy}
          onClick={() => setPickerOpen(true)}
          title={url ? `Replace ${label.toLowerCase()}` : `Add ${label.toLowerCase()}`}
        >
          {url ? 'Replace' : 'Add'}
        </button>
        {generatable && (
          <button
            type="button"
            className="storyboard-frame-generate"
            disabled={busy}
            title={`Regenerate ${label.toLowerCase()} using this row's pinned references`}
            onClick={() => setRegenOpen(true)}
          >
            {busyLabel || (url ? 'Regenerate' : 'Generate')}
          </button>
        )}
        {canGrab && (
          <button
            type="button"
            className="storyboard-frame-grab"
            disabled={busy}
            title="Use the last frame of the previous shot's generated video as this start frame."
            onClick={grabFromPrevious}
          >
            {busyLabel === 'Grabbing…' ? 'Grabbing…' : 'Grab from previous'}
          </button>
        )}
      </div>
      {error && <div className="error-banner small">{error}</div>}
      {generatable && (
        <FrameRegenerateDialog
          open={regenOpen}
          onClose={() => setRegenOpen(false)}
          onSubmit={submitRegen}
          role={role}
          hasImage={Boolean(url)}
          storyboardId={sbId}
        />
      )}
      <ReferencePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        sbId={sbId}
        beatId={beatId}
        charactersInScene={charactersInScene}
        role={role}
        onAttached={onRefresh}
      />
    </div>
  );
}

function ReferenceImages({
  ids,
  sbId,
  beatId,
  charactersInScene,
  onRefresh,
  onOpenLightbox,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function remove(id) {
    if (!confirm('Remove this reference image?')) return;
    setBusy(true);
    try {
      await apiDelete(`/storyboard/${sbId}/reference/${id}`);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="storyboard-refs">
      <div className="storyboard-frame-label">References</div>
      <div className="storyboard-refs-row">
        {(ids || []).map((id) => {
          const key = id?.toString?.() || String(id);
          return (
            <div className="storyboard-ref-thumb" key={key}>
              <img
                src={thumbUrl(key)}
                alt="reference"
                loading="lazy"
                onClick={() => onOpenLightbox?.(imageUrl(key), 'Reference')}
              />
              <button
                type="button"
                className="storyboard-frame-remove"
                title="Remove reference"
                disabled={busy}
                onClick={() => remove(key)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="storyboard-ref-add"
          disabled={busy}
          onClick={() => setPickerOpen(true)}
        >
          {busy ? '…' : '+'}
        </button>
      </div>
      {error && <div className="error-banner small">{error}</div>}
      <ReferencePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        sbId={sbId}
        beatId={beatId}
        charactersInScene={charactersInScene}
        currentReferenceIds={ids}
        onAttached={onRefresh}
      />
    </div>
  );
}


export function StoryboardItem({ sb, index, prevSb, onRefresh, onDelete }) {
  const id = sb._id?.toString?.() || String(sb._id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const [lightbox, setLightbox] = useState(null);
  const openLightbox = (src, alt) => setLightbox({ src, alt });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="storyboard-item">
      <div className="storyboard-item-header">
        <button
          type="button"
          className="storyboard-drag-handle"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <span className="storyboard-item-order">#{index + 1}</span>
        <div className="storyboard-item-actions">
          <GenerateVideoButton
            sb={sb}
            storyboardId={id}
            onRefresh={onRefresh}
          />
          <button
            type="button"
            className="storyboard-item-delete"
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>

      <ShotMetaRow sb={sb} sbId={id} onRefresh={onRefresh} />

      {sb.transition_in && (
        <div className="storyboard-transition" title="Continuity note">
          ↳ {sb.transition_in}
        </div>
      )}

      <div className="storyboard-frames-row">
        <FrameSlot
          label="Start frame"
          role="start_frame"
          imageId={sb.start_frame_id}
          sbId={id}
          beatId={sb.beat_id?.toString?.() || sb.beat_id}
          charactersInScene={sb.characters_in_scene}
          generatable
          prevSb={prevSb}
          onRefresh={onRefresh}
          onOpenLightbox={openLightbox}
        />
        <FrameSlot
          label="End frame"
          role="end_frame"
          imageId={sb.end_frame_id}
          sbId={id}
          beatId={sb.beat_id?.toString?.() || sb.beat_id}
          charactersInScene={sb.characters_in_scene}
          generatable
          onRefresh={onRefresh}
          onOpenLightbox={openLightbox}
        />
        <FrameSlot
          label="Character sheet"
          role="character_sheet"
          imageId={sb.character_sheet_image_id}
          sbId={id}
          beatId={sb.beat_id?.toString?.() || sb.beat_id}
          charactersInScene={sb.characters_in_scene}
          onRefresh={onRefresh}
          onOpenLightbox={openLightbox}
        />
      </div>

      <ReferenceImages
        ids={sb.reference_image_ids}
        sbId={id}
        beatId={sb.beat_id?.toString?.() || sb.beat_id}
        charactersInScene={sb.characters_in_scene}
        onRefresh={onRefresh}
        onOpenLightbox={openLightbox}
      />

      <AudioSlot
        audioId={sb.audio_file_id}
        uploadEndpoint={`/storyboard/${id}/audio`}
        deleteEndpoint={`/storyboard/${id}/audio`}
        recordingPrefix={`scene-${id}`}
        dialogPicker={{
          storyboardId: id,
          beatId: sb.beat_id?.toString?.() || sb.beat_id,
        }}
        onRefresh={onRefresh}
      />

      <StoryboardVideoPanel
        sb={sb}
        storyboardId={id}
        onRefresh={onRefresh}
      />

      <div className="storyboard-prompt">
        <div className="field-label">Prompt</div>
        <CollabField
          field={`item:${id}:text_prompt`}
          multiline
          placeholder="Describe what happens in this frame…"
        />
      </div>

      <ImageLightbox
        src={lightbox?.src || null}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}
