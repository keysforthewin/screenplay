import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';

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
//   image, descriptions, and continuity refs (matches what the batch generator
//   would produce for this row).
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
}) {
  const [mode, setMode] = useState('full');
  const [imageModel, setImageModel] = useState(readStoredModel);
  const [editPrompt, setEditPrompt] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setMode('full');
    setEditPrompt('');
    setCustomPrompt('');
  }, [open]);

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
  const canSubmit = editPromptValid && customPromptValid;

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      mode,
      imageModel,
      editPrompt: mode === 'edit' ? editPrompt.trim() : null,
      customPrompt: mode === 'custom' ? customPrompt.trim() : null,
    });
  }

  const label = ROLE_LABEL[role] || 'frame';
  let submitLabel;
  if (mode === 'edit') submitLabel = hasImage ? 'Edit' : 'Regenerate';
  else if (mode === 'custom') submitLabel = 'Generate';
  else submitLabel = hasImage ? 'Regenerate' : 'Generate';

  return (
    <Modal
      open={open}
      title={`${hasImage ? 'Regenerate' : 'Generate'} ${label}`}
      onClose={onClose}
      dismissible
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
                <strong>Full {hasImage ? 'regenerate' : 'generate'}</strong> — runs the
                full pipeline (character sheets, scene image, descriptions, continuity).
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
