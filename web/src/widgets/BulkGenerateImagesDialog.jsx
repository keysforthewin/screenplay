import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.storyboard.model';

// Page-level "Generate all images" dialog. Pick the image model; prompts and
// references are taken from each frame as already configured, so there are no
// prompt/reference inputs here. Shows how many start frames will be generated
// vs skipped (computed by the caller from the loaded storyboard list).
export function BulkGenerateImagesDialog({ open, onClose, onSubmit, missingCount = 0, skipCount = 0 }) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  const nothingToDo = missingCount === 0;

  return (
    <Modal
      open={open}
      title="Generate all images"
      onClose={onClose}
      dismissible
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={() => onSubmit({ imageModel })}
            disabled={nothingToDo}
          >
            Generate
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p className="modal-help" style={{ margin: 0 }}>
          {nothingToDo
            ? 'Every shot already has a start-frame image. Nothing to generate.'
            : `${missingCount} start frame${missingCount === 1 ? '' : 's'} missing → will be generated.` +
              (skipCount > 0
                ? ` ${skipCount} already ${skipCount === 1 ? 'has' : 'have'} an image → skipped.`
                : '')}
        </p>
        <p className="modal-help" style={{ margin: 0 }}>
          Each frame uses its own configured prompt and references. Frames with no
          saved prompt fall back to an auto-suggested one.
        </p>
        <div className="frame-generate-model-row">
          <span className="field-label">Image model</span>
          <div className="frame-generate-model-options">
            {IMAGE_MODELS.map((m) => (
              <label key={m.id}>
                <input
                  type="radio"
                  name="bulk-image-model"
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
