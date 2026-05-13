import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiPostJson } from '../api.js';

const MODEL_STORAGE_KEY = 'screenplay.storyboard.model';
const VALID_MODELS = new Set(['gemini', 'openai']);
const MODEL_LABEL = {
  gemini: 'Nano Banana (Gemini)',
  openai: 'OpenAI (gpt-image-2)',
};

function readStoredModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return VALID_MODELS.has(v) ? v : 'gemini';
  } catch {
    return 'gemini';
  }
}

const ROLE_LABEL = {
  start_frame: 'start frame',
  end_frame: 'end frame',
};

// Per-frame regen modal for FrameSlot. Three modes:
//
// - 'full' (default): runs the full pipeline with character sheets, scene
//   image, descriptions, and continuity refs. Fetches a preview of the
//   assembled prompt on open so the user can review and edit before sending.
//   For end_frame this includes the Claude camera-motion rewrite — the
//   rewrite is shown in the textarea, no longer applied silently.
// - 'edit': passes only the existing frame image plus a small user prompt.
//   Disabled when the slot is empty (nothing to edit).
// - 'custom': sends a user-written prompt verbatim with no references or
//   scaffolding. Pure text-to-image; works whether or not the slot is empty.
//
// Image model selector mirrors the page-level dialog's, sharing localStorage so
// a chosen model sticks across both flows.
export function FrameRegenerateDialog({
  open,
  onClose,
  onSubmit,
  role,
  hasImage,
  storyboardId,
}) {
  const [mode, setMode] = useState('full');
  const [imageModel, setImageModel] = useState(readStoredModel);
  const [editPrompt, setEditPrompt] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [previewPrompt, setPreviewPrompt] = useState('');
  const [previewMeta, setPreviewMeta] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  // Continuity-ref opt-in. Defaults true so the dialog behaves the way it
  // always has unless the user unticks. start_frame: previous shot's end
  // frame. end_frame: this row's start frame.
  const [includeContinuity, setIncludeContinuity] = useState(true);
  const [includeStartFrame, setIncludeStartFrame] = useState(true);
  // Tracks the most recent fetch so a stale response can't clobber a later one
  // (user spam-toggles modes or reopens before the first response lands).
  const previewSeqRef = useRef(0);

  const fetchPreview = useCallback(
    async ({ includeContinuity: ic, includeStartFrame: isf } = {}) => {
      if (!storyboardId || !role) return;
      const seq = ++previewSeqRef.current;
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await apiPostJson(
          `/storyboard/${storyboardId}/frame/${role}/preview-prompt`,
          {
            include_continuity: ic,
            include_start_frame: isf,
          },
        );
        if (seq !== previewSeqRef.current) return;
        setPreviewPrompt(typeof res?.prompt === 'string' ? res.prompt : '');
        setPreviewMeta({
          reference_count: res?.reference_count ?? 0,
          has_start_frame_ref: !!res?.has_start_frame_ref,
          has_set_image: !!res?.has_set_image,
          character_count: res?.character_count ?? 0,
          reference_image_count: res?.reference_image_count ?? 0,
          has_pinned_sheet: !!res?.has_pinned_sheet,
          has_prev_end_frame: !!res?.has_prev_end_frame,
          has_row_start_frame: !!res?.has_row_start_frame,
        });
      } catch (e) {
        if (seq !== previewSeqRef.current) return;
        setPreviewError(e?.message || 'Failed to load preview prompt.');
        setPreviewPrompt('');
        setPreviewMeta(null);
      } finally {
        if (seq === previewSeqRef.current) setPreviewLoading(false);
      }
    },
    [storyboardId, role],
  );

  // Reset transient state each time the dialog opens, and load the initial
  // preview. Checkbox onChange handlers do their own fetches so toggling
  // re-renders the prompt with the new flags applied.
  useEffect(() => {
    if (!open) {
      // Invalidate any in-flight fetch when the dialog closes.
      previewSeqRef.current++;
      return;
    }
    setMode('full');
    setEditPrompt('');
    setCustomPrompt('');
    setPreviewPrompt('');
    setPreviewMeta(null);
    setPreviewError(null);
    setIncludeContinuity(true);
    setIncludeStartFrame(true);
    fetchPreview({ includeContinuity: true, includeStartFrame: true });
  }, [open, fetchPreview]);

  // Force mode back to full if the slot is empty (Edit option is disabled in
  // that case anyway, but defend against stale state).
  useEffect(() => {
    if (!hasImage && mode === 'edit') setMode('full');
  }, [hasImage, mode]);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, imageModel);
    } catch {}
  }, [imageModel]);

  const editPromptValid =
    mode !== 'edit' || (typeof editPrompt === 'string' && editPrompt.trim().length > 0);
  const customPromptValid =
    mode !== 'custom' || (typeof customPrompt === 'string' && customPrompt.trim().length > 0);
  const fullPromptValid =
    mode !== 'full' || (typeof previewPrompt === 'string' && previewPrompt.trim().length > 0);
  const canSubmit =
    editPromptValid &&
    customPromptValid &&
    fullPromptValid &&
    !(mode === 'full' && previewLoading);

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      mode,
      imageModel,
      editPrompt: mode === 'edit' ? editPrompt.trim() : null,
      customPrompt: mode === 'custom' ? customPrompt.trim() : null,
      promptOverride: mode === 'full' ? previewPrompt.trim() : null,
      includeContinuity,
      includeStartFrame,
    });
  }

  // Continuity checkbox is meaningful only when there's actually a previous
  // shot to anchor on. start_frame: previous row must have an end_frame.
  // end_frame: this row must have its own start_frame.
  const continuityAvailable =
    role === 'start_frame'
      ? !!previewMeta?.has_prev_end_frame
      : !!previewMeta?.has_row_start_frame;

  const label = ROLE_LABEL[role] || 'frame';
  let submitLabel;
  if (mode === 'edit') submitLabel = hasImage ? 'Edit' : 'Regenerate';
  else if (mode === 'custom') submitLabel = 'Generate';
  else submitLabel = hasImage ? 'Regenerate' : 'Generate';

  // Full mode only attaches images that live on this storyboard row
  // (character_sheet_image_id + reference_image_ids) plus an optional
  // continuity anchor. Beat scene image and beat character roster are
  // intentionally NOT loaded.
  const refSummary = previewMeta
    ? [
        previewMeta.has_pinned_sheet || previewMeta.character_count
          ? '1 character sheet'
          : null,
        previewMeta.reference_image_count
          ? `${previewMeta.reference_image_count} reference ${
              previewMeta.reference_image_count === 1 ? 'image' : 'images'
            }`
          : null,
        previewMeta.has_start_frame_ref ? '1 start frame' : null,
        role === 'start_frame' &&
        previewMeta.reference_count &&
        includeContinuity &&
        previewMeta.has_prev_end_frame
          ? "1 previous shot's end frame"
          : null,
      ]
        .filter(Boolean)
        .join(', ')
    : '';

  return (
    <Modal
      open={open}
      title={`${hasImage ? 'Regenerate' : 'Generate'} ${label}`}
      onClose={onClose}
      dismissible
      size="wide"
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <span className="field-label">Mode</span>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}
          >
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13 }}
            >
              <input
                type="radio"
                name="frame-regen-mode"
                value="full"
                checked={mode === 'full'}
                onChange={() => setMode('full')}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Full {hasImage ? 'regenerate' : 'generate'}</strong> — sends
                this row's pinned character sheet and reference images (if any) along
                with the prompt below. Preview and edit before sending.
              </span>
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                fontSize: 13,
                opacity: hasImage ? 1 : 0.5,
              }}
              title={hasImage ? '' : 'No existing image to edit'}
            >
              <input
                type="radio"
                name="frame-regen-mode"
                value="edit"
                checked={mode === 'edit'}
                disabled={!hasImage}
                onChange={() => setMode('edit')}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Edit</strong> — pass only this image with a small prompt.
                {!hasImage && (
                  <span style={{ color: 'var(--fg-muted)' }}>
                    {' '}
                    (no existing image)
                  </span>
                )}
              </span>
            </label>
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13 }}
            >
              <input
                type="radio"
                name="frame-regen-mode"
                value="custom"
                checked={mode === 'custom'}
                onChange={() => setMode('custom')}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Custom</strong> — write your own prompt; sent verbatim with no
                references or scene scaffolding.
              </span>
            </label>
          </div>
        </div>

        {mode === 'full' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span
              className="field-label"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
            >
              <span>Prompt sent to image model</span>
              <button
                type="button"
                onClick={() =>
                  fetchPreview({ includeContinuity, includeStartFrame })
                }
                disabled={previewLoading}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent, #4a9eff)',
                  cursor: previewLoading ? 'default' : 'pointer',
                  fontSize: 12,
                  padding: 0,
                }}
                title="Re-fetch the assembled prompt from the server (discards your edits)"
              >
                Reset to backend default
              </button>
            </span>
            <textarea
              value={previewPrompt}
              onChange={(e) => setPreviewPrompt(e.target.value)}
              rows={12}
              placeholder={
                previewLoading
                  ? 'Building prompt…'
                  : 'The assembled prompt will appear here.'
              }
              disabled={previewLoading}
              style={{ fontFamily: 'var(--mono-font, ui-monospace, monospace)', fontSize: 12 }}
            />
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              {previewLoading
                ? 'Loading preview…'
                : previewError
                  ? `Preview error: ${previewError}. You can still type a prompt here to override.`
                  : refSummary
                    ? `Sent verbatim to the image model along with: ${refSummary}.`
                    : 'Sent verbatim to the image model.'}
            </span>
            {role === 'start_frame' && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  fontSize: 12,
                  marginTop: 4,
                  opacity: continuityAvailable ? 1 : 0.5,
                }}
                title={
                  continuityAvailable
                    ? ''
                    : "No previous shot's end frame available."
                }
              >
                <input
                  type="checkbox"
                  checked={includeContinuity && continuityAvailable}
                  disabled={!continuityAvailable || previewLoading}
                  onChange={(e) => setIncludeContinuity(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  Include previous shot's end frame for continuity
                </span>
              </label>
            )}
            {role === 'end_frame' && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  fontSize: 12,
                  marginTop: 4,
                  opacity: continuityAvailable ? 1 : 0.5,
                }}
                title={
                  continuityAvailable
                    ? ''
                    : 'No start frame on this row to anchor on.'
                }
              >
                <input
                  type="checkbox"
                  checked={includeStartFrame && continuityAvailable}
                  disabled={!continuityAvailable || previewLoading}
                  onChange={(e) => setIncludeStartFrame(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  Anchor on this row's start frame (transform it into the end frame)
                </span>
              </label>
            )}
          </div>
        )}

        {mode === 'edit' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="field-label">Edit prompt</span>
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              rows={3}
              placeholder='e.g. "remove the lamp on the left"'
            />
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Sent verbatim to the image model along with the existing frame.
            </span>
          </label>
        )}

        {mode === 'custom' && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="field-label">Custom prompt</span>
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={5}
              placeholder='e.g. "wide shot, neon-lit alley at night, rain on cobblestones"'
            />
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Sent verbatim to the image model. No references, no scene context.
            </span>
          </label>
        )}

        <div>
          <span className="field-label">Image model</span>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}
          >
            {['gemini', 'openai'].map((m) => (
              <label
                key={m}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
              >
                <input
                  type="radio"
                  name="frame-image-model"
                  value={m}
                  checked={imageModel === m}
                  onChange={() => setImageModel(m)}
                />
                {MODEL_LABEL[m]}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
