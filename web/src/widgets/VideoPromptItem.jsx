import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiDelete, apiPatchJson, thumbUrl } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { GenerateVideoDialog } from './GenerateVideoDialog.jsx';
import { StoryboardVideoPanel } from './StoryboardVideoPanel.jsx';
import { PromptReferencePicker } from './PromptReferencePicker.jsx';

const MAX_REFS = 9;

// One Prompts-tab row: title + prompt text (collaborative), a target duration,
// the ORDERED reference strip (@Image1..N — the order is what the prompt text
// binds to, so the chips can be shifted left/right), the Generate video
// button, and the inline player once a clip lands.
export function VideoPromptItem({ prompt, index, beatId, disabled, onRefresh, onDelete }) {
  const id = prompt._id?.toString?.() || String(prompt._id);
  const [videoOpen, setVideoOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [durationDraft, setDurationDraft] = useState(null);

  const refs = Array.isArray(prompt.reference_images) ? prompt.reference_images : [];
  const refIds = refs.map((r) => r.image_id?.toString?.() || String(r.image_id));

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

  async function patch(body) {
    setBusy(true);
    setError(null);
    try {
      await apiPatchJson(`/video-prompt/${id}`, body);
      onRefresh?.();
    } catch (e) {
      let msg = e.message || 'Update failed.';
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error) msg = parsed.error;
      } catch {}
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function commitDuration() {
    if (durationDraft == null) return;
    const raw = String(durationDraft).trim();
    setDurationDraft(null);
    if (raw === '') {
      if (prompt.duration_seconds != null) patch({ duration_seconds: null });
      return;
    }
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      setError('Duration must be between 1 and 60 seconds.');
      return;
    }
    if (n !== prompt.duration_seconds) patch({ duration_seconds: n });
  }

  function moveRef(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= refIds.length) return;
    const next = [...refIds];
    [next[i], next[j]] = [next[j], next[i]];
    patch({ reference_image_ids: next });
  }

  function removeRef(i) {
    patch({ reference_image_ids: refIds.filter((_, k) => k !== i) });
  }

  async function discardVideo() {
    if (!confirm('Discard the generated video for this prompt?')) return;
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/video-prompt/${id}/video`);
      onRefresh?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const hasVideo = Boolean(prompt.video_file_id);

  return (
    <div ref={setNodeRef} style={style} className="dialog-item video-prompt-item">
      <div className="dialog-item-header">
        <button
          type="button"
          className="dialog-drag-handle"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <span className="video-prompt-index">#{index + 1}</span>
        <div className="video-prompt-title">
          <CollabField field={`item:${id}:title`} placeholder="Prompt title…" />
        </div>
        <label className="video-prompt-duration" title="Target clip length in seconds (the model snaps to what it supports)">
          <span className="field-label" style={{ margin: 0 }}>Duration</span>
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={durationDraft ?? (prompt.duration_seconds ?? '')}
            disabled={busy || disabled}
            onChange={(e) => setDurationDraft(e.target.value)}
            onBlur={commitDuration}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            style={{ width: 64 }}
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>s</span>
        </label>
        <button
          type="button"
          className="dialog-item-delete"
          onClick={onDelete}
          disabled={busy || disabled}
        >
          Delete
        </button>
      </div>

      <div className="dialog-item-fields">
        {error && <div className="error-banner small">{error}</div>}

        <div className="video-prompt-refs">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Reference images</span>
            <span style={{ fontWeight: 400, color: 'var(--fg-muted)' }}>
              — sent in this order as @Image1…@Image{refs.length || 'N'}
            </span>
          </div>
          <div className="video-prompt-ref-strip">
            {refs.map((r, i) => {
              const rid = refIds[i];
              return (
                <div key={rid} className="video-prompt-ref-chip" title={r.label || ''}>
                  <img src={thumbUrl(rid)} alt={r.label || `Reference ${i + 1}`} loading="lazy" />
                  <span className="video-prompt-ref-handle">@Image{i + 1}</span>
                  <span className="video-prompt-ref-owner">{r.owner_name || ''}</span>
                  <div className="video-prompt-ref-actions">
                    <button
                      type="button"
                      title="Move earlier"
                      disabled={busy || disabled || i === 0}
                      onClick={() => moveRef(i, -1)}
                    >
                      ◀
                    </button>
                    <button
                      type="button"
                      title="Move later"
                      disabled={busy || disabled || i === refs.length - 1}
                      onClick={() => moveRef(i, +1)}
                    >
                      ▶
                    </button>
                    <button
                      type="button"
                      title="Remove this reference"
                      disabled={busy || disabled}
                      onClick={() => removeRef(i)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
            <button
              type="button"
              className="video-prompt-ref-add"
              disabled={busy || disabled || refs.length >= MAX_REFS}
              title={refs.length >= MAX_REFS ? `At most ${MAX_REFS} references` : 'Add artwork from this beat\'s characters and sets as reference images'}
              onClick={() => setPickerOpen(true)}
            >
              + Add reference
            </button>
          </div>
        </div>

        <div className="dialog-item-body">
          <div className="field-label">Prompt</div>
          <CollabField
            field={`item:${id}:prompt`}
            multiline
            placeholder="Bind the handles first (@Image1 is …), then the shots in order with [bracketed camera] instructions…"
          />
        </div>

        <div className="video-prompt-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || disabled}
            title={hasVideo ? 'Re-generate the video for this prompt' : 'Pick a video model and render this prompt'}
            onClick={() => setVideoOpen(true)}
          >
            {hasVideo ? '🎬 Re-generate video' : '🎬 Generate video'}
          </button>
          {hasVideo ? (
            <button type="button" className="danger" disabled={busy || disabled} onClick={discardVideo}>
              Discard video
            </button>
          ) : null}
        </div>

        <StoryboardVideoPanel sb={prompt} />
      </div>

      <GenerateVideoDialog
        open={videoOpen}
        onClose={() => setVideoOpen(false)}
        storyboardId={id}
        sb={prompt}
        onRefresh={onRefresh}
        variant="video_prompt"
        promptField={`item:${id}:prompt`}
      />
      <PromptReferencePicker
        open={pickerOpen}
        beatId={beatId}
        existingIds={refIds}
        maxTotal={MAX_REFS}
        onClose={() => setPickerOpen(false)}
        onPick={(ids) => {
          setPickerOpen(false);
          patch({ reference_image_ids: [...refIds, ...ids] });
        }}
      />
    </div>
  );
}
