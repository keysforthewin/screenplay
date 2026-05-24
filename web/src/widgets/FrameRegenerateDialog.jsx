import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ReferencePickerModal } from './ReferencePickerModal.jsx';
import { apiPostJson, imageUrl, thumbUrl } from '../api.js';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.storyboard.model';

// Per-frame generate / regenerate modal. Renders full-screen so the reference
// grid, prompt editor, and model selector are all visible at once. Renders the
// frame from the user's edited prompt plus the persisted per-frame reference
// images. The prompt is also saved back to the frame's stored prompt on submit
// so the textarea state survives across sessions.
//
// Inline single-image edits live in StoryboardFrameEditDialog (the dedicated
// Edit button on each frame) — that flow has its own thumbnail-and-undo modal.
//
// References live in a dedicated column on the left and are managed by the
// existing ReferencePickerModal (multi-select Apply hits the per-frame route).
export function FrameRegenerateDialog({
  open,
  onClose,
  onSubmit,
  frameId,
  hasImage,
  storyboardId,
  beatId,
  charactersInScene,
  referenceIds,
  onReferencesChanged,
}) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [prompt, setPrompt] = useState('');
  const [suggestedPrompt, setSuggestedPrompt] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [refsError, setRefsError] = useState(null);
  // Tracks the most recent fetch so a stale response can't clobber a later one.
  const previewSeqRef = useRef(0);

  const fetchPreview = useCallback(async () => {
    if (!storyboardId || !frameId) return;
    const seq = ++previewSeqRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await apiPostJson(
        `/storyboard/${storyboardId}/frame/${frameId}/preview-prompt`,
        {},
      );
      if (seq !== previewSeqRef.current) return;
      const stored = typeof res?.prompt === 'string' ? res.prompt : '';
      const suggested =
        typeof res?.suggested_prompt === 'string' ? res.suggested_prompt : stored;
      setPrompt(stored);
      setSuggestedPrompt(suggested);
    } catch (e) {
      if (seq !== previewSeqRef.current) return;
      setPreviewError(e?.message || 'Failed to load suggested prompt.');
    } finally {
      if (seq === previewSeqRef.current) setPreviewLoading(false);
    }
  }, [storyboardId, frameId]);

  useEffect(() => {
    if (!open) {
      previewSeqRef.current++;
      return;
    }
    setPrompt('');
    setSuggestedPrompt('');
    setPreviewError(null);
    setRefsError(null);
    fetchPreview();
  }, [open, fetchPreview]);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  async function autoSuggestReferences() {
    if (autoBusy) return;
    setAutoBusy(true);
    setRefsError(null);
    try {
      await apiPostJson(
        `/storyboard/${storyboardId}/frame/${frameId}/reference/auto-populate`,
        {},
      );
      await onReferencesChanged?.();
    } catch (e) {
      setRefsError(e?.message || 'Auto-suggest failed.');
    } finally {
      setAutoBusy(false);
    }
  }

  async function removeReference(id) {
    if (!confirm('Remove this reference image?')) return;
    setRefsError(null);
    try {
      await apiPostJson(
        `/storyboard/${storyboardId}/frame/${frameId}/reference/set`,
        {
          image_ids: (referenceIds || [])
            .map((x) => x?.toString?.() || String(x))
            .filter((x) => x !== id),
        },
      );
      await onReferencesChanged?.();
    } catch (e) {
      setRefsError(e?.message || 'Remove failed.');
    }
  }

  const promptValid =
    typeof prompt === 'string' && prompt.trim().length > 0;
  const canSubmit = promptValid && !previewLoading;

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      mode: 'generate',
      imageModel,
      prompt: prompt.trim(),
      editPrompt: null,
    });
  }

  const label = 'frame';
  const submitLabel = hasImage ? 'Regenerate' : 'Generate';

  const refList = (referenceIds || []).map(
    (id) => id?.toString?.() || String(id),
  );

  return (
    <>
      <Modal
        open={open}
        title={`${hasImage ? 'Regenerate' : 'Generate'} ${label}`}
        onClose={onClose}
        dismissible
        size="fullscreen"
        footer={
          <>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={submit}
              disabled={!canSubmit}
            >
              {submitLabel}
            </button>
          </>
        }
      >
        <div className="frame-generate-modal">
          <div className="frame-generate-body">
            <div className="frame-generate-refs">
              <div className="frame-generate-section-header">
                <span className="field-label">References</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={autoSuggestReferences}
                    disabled={autoBusy}
                    title="Pull references from this beat and the in-scene characters"
                  >
                    {autoBusy ? 'Auto-suggesting…' : 'Auto-suggest'}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setPickerOpen(true)}
                  >
                    + Add references
                  </button>
                </div>
              </div>
              {refsError && (
                <div className="error-banner small">{refsError}</div>
              )}
              <div className="frame-generate-ref-grid">
                {refList.length === 0 ? (
                  <div className="frame-generate-ref-empty">
                    No reference images yet. Use Auto-suggest or Add
                    references to attach images that anchor this frame's
                    generation.
                  </div>
                ) : (
                  refList.map((id) => (
                    <div className="frame-generate-ref-thumb" key={id}>
                      <img
                        src={thumbUrl(id)}
                        alt="reference"
                        loading="lazy"
                        onClick={() =>
                          window.open(imageUrl(id), '_blank', 'noopener')
                        }
                      />
                      <button
                        type="button"
                        className="storyboard-frame-remove"
                        title="Remove reference"
                        onClick={() => removeReference(id)}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="frame-generate-prompt">
              <div className="frame-generate-section-header">
                <span className="field-label">Prompt</span>
                <button
                  type="button"
                  onClick={() => setPrompt(suggestedPrompt)}
                  disabled={previewLoading || !suggestedPrompt}
                  title="Replace the textarea with the auto-suggested default"
                >
                  Reset to suggested default
                </button>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  previewLoading
                    ? 'Loading suggested prompt…'
                    : 'Describe how this frame should look. Sent verbatim to the image model.'
                }
                disabled={previewLoading}
                className="frame-generate-textarea"
              />
              <span className="frame-generate-help">
                {previewLoading
                  ? 'Loading…'
                  : previewError
                    ? `Preview error: ${previewError}.`
                    : `Saved to this frame's stored prompt on Generate. Sent along with ${refList.length} reference ${refList.length === 1 ? 'image' : 'images'}.`}
              </span>
            </div>
          </div>

          <div className="frame-generate-model-row">
            <span className="field-label">Image model</span>
            <div className="frame-generate-model-options">
              {IMAGE_MODELS.map((m) => (
                <label key={m.id}>
                  <input
                    type="radio"
                    name="frame-image-model"
                    value={m.id}
                    checked={imageModel === m.id}
                    onChange={() => setImageModel(m.id)}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>
      <ReferencePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        sbId={storyboardId}
        beatId={beatId}
        charactersInScene={charactersInScene}
        currentReferenceIds={refList}
        mode="frame_reference"
        frameId={frameId}
        onAttached={onReferencesChanged}
      />
    </>
  );
}
