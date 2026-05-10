import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  apiDelete,
  apiPatchJson,
  apiPostJson,
  apiPostMultipart,
  attachmentUrl,
  imageUrl,
} from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
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

function FrameSlot({ label, role, imageId, sbId, generatable, onRefresh }) {
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState(null);
  const [error, setError] = useState(null);
  const url = imageUrl(imageId);

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setBusyLabel('Uploading…');
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('role', role);
      await apiPostMultipart(`/storyboard/${sbId}/image`, fd);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setBusyLabel(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

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

  async function generate() {
    setBusy(true);
    setBusyLabel('Generating…');
    setError(null);
    try {
      await apiPostJson(`/storyboard/${sbId}/frame/${role}/generate`, {});
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  }

  return (
    <div className="storyboard-frame">
      <div className="storyboard-frame-label">{label}</div>
      {url ? (
        <div className="storyboard-frame-img-wrap">
          <img src={url} alt={label} />
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
          onClick={() => fileInput.current?.click()}
        >
          {busyLabel || '+ Upload'}
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={upload}
      />
      <div className="storyboard-frame-actions">
        {url && (
          <button
            type="button"
            className="storyboard-frame-replace"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Replace
          </button>
        )}
        {generatable && (
          <button
            type="button"
            className="storyboard-frame-generate"
            disabled={busy}
            title={`Generate ${label.toLowerCase()} from the prompt + scene + character sheets`}
            onClick={generate}
          >
            {busyLabel === 'Generating…' ? 'Generating…' : url ? 'Regenerate' : 'Generate'}
          </button>
        )}
      </div>
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}

function ReferenceImages({ ids, sbId, onRefresh }) {
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(`/storyboard/${sbId}/reference`, fd);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

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
              <img src={imageUrl(key)} alt="reference" />
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
          onClick={() => fileInput.current?.click()}
        >
          {busy ? '…' : '+'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={upload}
        />
      </div>
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}

function AudioSlot({ audioId, sbId, onRefresh }) {
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const url = attachmentUrl(audioId);

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(`/storyboard/${sbId}/audio`, fd);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove() {
    if (!confirm('Remove audio?')) return;
    setBusy(true);
    try {
      await apiDelete(`/storyboard/${sbId}/audio`);
      await onRefresh?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="storyboard-audio">
      <div className="storyboard-frame-label">Audio</div>
      {url ? (
        <div className="storyboard-audio-row">
          <audio controls src={url} preload="metadata" />
          <button type="button" disabled={busy} onClick={remove}>
            ×
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? 'Uploading…' : '+ Upload audio'}
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={upload}
      />
      {error && <div className="error-banner small">{error}</div>}
    </div>
  );
}

export function StoryboardItem({ sb, index, onRefresh, onDelete }) {
  const id = sb._id?.toString?.() || String(sb._id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

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
        <button
          type="button"
          className="storyboard-item-delete"
          onClick={onDelete}
        >
          Delete
        </button>
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
          generatable
          onRefresh={onRefresh}
        />
        <FrameSlot
          label="End frame"
          role="end_frame"
          imageId={sb.end_frame_id}
          sbId={id}
          generatable
          onRefresh={onRefresh}
        />
        <FrameSlot
          label="Character sheet"
          role="character_sheet"
          imageId={sb.character_sheet_image_id}
          sbId={id}
          onRefresh={onRefresh}
        />
      </div>

      <ReferenceImages
        ids={sb.reference_image_ids}
        sbId={id}
        onRefresh={onRefresh}
      />

      <AudioSlot audioId={sb.audio_file_id} sbId={id} onRefresh={onRefresh} />

      <div className="storyboard-prompt">
        <div className="field-label">Prompt</div>
        <CollabField
          field={`item:${id}:text_prompt`}
          multiline
          placeholder="Describe what happens in this frame…"
        />
      </div>
    </div>
  );
}
