import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';
import { fetchImageModels } from '../api.js';

const MODEL_STORAGE_KEY = 'screenplay.storyboard.model';

// Page-level "Generate all images" dialog. Pick the image model; prompts and
// references are taken from each frame as already configured, so there are no
// prompt/reference inputs here. Shows how many start frames will be generated
// vs skipped (computed by the caller from the loaded storyboard list).
export function BulkGenerateImagesDialog({ open, onClose, onSubmit, missingCount = 0, skipCount = 0 }) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [autoReferences, setAutoReferences] = useState(true);
  const [modelInfo, setModelInfo] = useState({});

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchImageModels()
      .then((models) => {
        if (!alive) return;
        const byId = {};
        for (const m of models) byId[m.id] = m;
        setModelInfo(byId);
      })
      .catch(() => { /* label-only fallback */ });
    return () => { alive = false; };
  }, [open]);

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
            onClick={() => onSubmit({ imageModel, autoReferences })}
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
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <input
            type="checkbox"
            checked={autoReferences}
            onChange={(e) => setAutoReferences(e.target.checked)}
          />
          <span className="modal-help" style={{ margin: 0 }}>
            Auto-pick reference images for frames that have none, from the library
            artwork and the characters in each scene.
          </span>
        </label>
        <div className="frame-generate-model-row">
          <span className="field-label">Image model</span>
          <div className="frame-generate-model-options">
            {IMAGE_MODELS.map((m) => {
              const info = modelInfo[m.id];
              return (
                <label key={m.id}>
                  <input
                    type="radio"
                    name="bulk-image-model"
                    value={m.id}
                    checked={imageModel === m.id}
                    onChange={() => setImageModel(m.id)}
                  />
                  <span>
                    {m.label}
                    {info && (
                      <span className="model-meta" style={{ display: 'block', opacity: 0.7, fontSize: '0.85em' }}>
                        {info.maxReferenceImages} ref images · {info.resolution} · {info.inputFormats.join('/')}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
