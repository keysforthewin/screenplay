import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.imageEdit.model';

// Per-image edit/regenerate modal used by ImageGallery on beat and character
// pages. Two modes, both of which use the existing image as a reference:
// - 'edit'    → existing image bytes + prompt go to the model, and the result
//               REPLACES the existing image in its slot (preserving position;
//               main-image status carries over). Use for small inline tweaks.
// - 'variant' → existing image is fed in as a reference and the result is ADDED
//               as a NEW image in the gallery; the original is kept untouched.
// (Pure text-to-image with no reference lives in the "+ Add image" picker.)
export function ImageEditDialog({ open, onClose, onSubmit }) {
  const [mode, setMode] = useState('edit');
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [prompt, setPrompt] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('edit');
    setPrompt('');
  }, [open]);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  const trimmed = prompt.trim();
  const canSubmit = trimmed.length > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ mode, imageModel, prompt: trimmed });
  }

  const submitLabel = mode === 'edit' ? 'Edit image' : 'Create variant';

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
                value="variant"
                checked={mode === 'variant'}
                onChange={() => setMode('variant')}
                style={{ marginTop: 3 }}
              />
              <span>
                <strong>Create variant</strong> — keep this image and add a
                brand-new one to the gallery, using this image as a reference.
              </span>
            </label>
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">
            {mode === 'edit' ? 'Edit prompt' : 'Variant prompt'}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder={
              mode === 'edit'
                ? 'e.g. "change her jacket to red"'
                : 'e.g. "same character, three-quarter profile, golden hour"'
            }
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            {mode === 'edit'
              ? 'Sent verbatim with the existing image as reference; replaces this image.'
              : 'Sent verbatim with the existing image as reference; adds a new image.'}
          </span>
        </label>

        <div>
          <span className="field-label">Image model</span>
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}
          >
            {IMAGE_MODELS.map((m) => (
              <label
                key={m.id}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
              >
                <input
                  type="radio"
                  name="image-edit-model"
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
  );
}
