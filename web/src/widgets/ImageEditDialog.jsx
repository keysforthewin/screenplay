import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';

const MODEL_STORAGE_KEY = 'screenplay.imageEdit.model';
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

// Per-image edit/regenerate modal used by ImageGallery on beat and character
// pages. Two modes:
// - 'edit'     → the existing image bytes + the prompt go to the chosen model.
//                Use for small inline tweaks ("change her jacket to red").
// - 'generate' → pure text-to-image with no reference. The existing image is
//                replaced by a fresh one built from the prompt alone.
// In both cases the result REPLACES the existing image in its slot (preserving
// the slot's position; main-image status carries over if applicable).
export function ImageEditDialog({ open, onClose, onSubmit }) {
  const [mode, setMode] = useState('edit');
  const [imageModel, setImageModel] = useState(readStoredModel);
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('edit');
    setPrompt('');
  }, [open]);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, imageModel);
    } catch {}
  }, [imageModel]);

  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ mode, imageModel, prompt: trimmed });
  }

  const submitLabel = mode === 'edit' ? 'Edit image' : 'Generate replacement';

  return (
    <Modal
      open={open}
      title="Edit / regenerate image"
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
                name="image-edit-mode"
                value="edit"
                checked={mode === 'edit'}
                onChange={() => setMode('edit')}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Edit existing</strong> — pass this image + your prompt
                to the model for small tweaks.
              </span>
            </label>
            <label
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 13 }}
            >
              <input
                type="radio"
                name="image-edit-mode"
                value="generate"
                checked={mode === 'generate'}
                onChange={() => setMode('generate')}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Generate new</strong> — replace this image entirely with
                a brand-new one built from your prompt alone.
              </span>
            </label>
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">
            {mode === 'edit' ? 'Edit prompt' : 'New image prompt'}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder={
              mode === 'edit'
                ? 'e.g. "change her jacket to red"'
                : 'e.g. "moody portrait, dim warm light, 35mm film grain"'
            }
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {mode === 'edit'
              ? 'Sent verbatim with the existing image as reference.'
              : 'Sent verbatim with no reference image.'}
          </span>
        </label>

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
                  name="image-edit-model"
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
