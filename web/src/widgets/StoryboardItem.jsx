import { useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  apiDelete,
  apiPostMultipart,
  attachmentUrl,
  imageUrl,
} from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';

// Frame slot that supports replace via file picker and a delete button.
function FrameSlot({ label, role, imageId, sbId, onRefresh }) {
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const url = imageUrl(imageId);

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
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
          {busy ? 'Uploading…' : '+ Upload'}
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={upload}
      />
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

      <div className="storyboard-frames-row">
        <FrameSlot
          label="Start frame"
          role="start_frame"
          imageId={sb.start_frame_id}
          sbId={id}
          onRefresh={onRefresh}
        />
        <FrameSlot
          label="End frame"
          role="end_frame"
          imageId={sb.end_frame_id}
          sbId={id}
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
