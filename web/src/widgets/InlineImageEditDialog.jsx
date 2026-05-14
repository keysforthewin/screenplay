import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { imageUrl } from '../api.js';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

// Generic in-line image editor dialog. Drives:
//   - Artwork edits (ArtworkEditDialog wraps this)
//   - Storyboard frame edits (StoryboardFrameEditDialog wraps this)
//
// The wrapper supplies callbacks for the actual mutation; this component
// owns the layout (thumbnail + prompt + model selector + Apply/Undo/Close)
// and the busy/spinner lifecycle.
//
// Lifecycle:
//   1. User types prompt → clicks Apply → wrapper.applyEdit({prompt, model}).
//   2. Dialog stays open showing a spinner. The wrapper is responsible for
//      flipping `status` to 'pending' if it tracks one; otherwise the local
//      `busy` flag still shows the spinner while the awaited callback runs.
//   3. When `status` exits 'pending' the spinner clears. If `status === 'error'`
//      the wrapper's `errorMessage` is surfaced.
//   4. Undo: wrapper.undoEdit() — synchronous swap of previous → current.
//
// Props:
//   open, onClose, onDone   refresh callback fired after each successful action
//   title:           dialog title (e.g. "Edit artwork", "Edit start frame")
//   imageId:         GridFS id for the preview thumbnail (or null)
//   status:          'done' | 'pending' | 'error'
//   errorMessage:    optional string from the upstream entity doc
//   hasUndo:         boolean — controls Undo button enable
//   applyEdit:       async ({prompt, model}) => void
//   undoEdit:        async () => void
//   modelStorageKey: localStorage key for last-used model persistence
export function InlineImageEditDialog({
  open,
  onClose,
  onDone,
  title = 'Edit image',
  imageId,
  status = 'done',
  errorMessage = null,
  hasUndo = false,
  applyEdit,
  undoEdit,
  modelStorageKey,
}) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [imageModel, setImageModel] = useState(() =>
    readStoredImageModel(modelStorageKey),
  );
  const openSeqRef = useRef(0);

  useEffect(() => {
    writeStoredImageModel(modelStorageKey, imageModel);
  }, [modelStorageKey, imageModel]);

  const resultId =
    imageId?.toString?.() || (imageId ? String(imageId) : null);

  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      return;
    }
    setPrompt('');
    setError(null);
    setBusy(false);
  }, [open, resultId]);

  // When the upstream status leaves 'pending' (the job either landed or
  // errored), drop the local `busy` indicator. We don't close the dialog
  // automatically — the user might want to iterate.
  useEffect(() => {
    if (!open) return;
    if (status !== 'pending' && busy) {
      setBusy(false);
      if (status === 'error') {
        setError(errorMessage || 'Edit failed.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, open]);

  const canApply =
    prompt.trim().length > 0 && status !== 'pending' && !busy && !!applyEdit;
  const canUndo = hasUndo && status !== 'pending' && !busy && !!undoEdit;

  async function handleApply() {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      await applyEdit({ prompt: prompt.trim(), model: imageModel });
      await onDone?.();
      if (seq === openSeqRef.current) setPrompt('');
    } catch (e) {
      if (seq === openSeqRef.current) {
        setError(e?.message || 'Edit failed');
        setBusy(false);
      }
    }
  }

  async function handleUndo() {
    if (!canUndo) return;
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      await undoEdit();
      await onDone?.();
      if (seq === openSeqRef.current) setBusy(false);
    } catch (e) {
      if (seq === openSeqRef.current) {
        setError(e?.message || 'Undo failed');
        setBusy(false);
      }
    }
  }

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      dismissible={!busy && status !== 'pending'}
      size="wide"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
            title={hasUndo ? 'Revert the most recent edit' : 'Nothing to undo'}
          >
            Undo
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleApply}
            disabled={!canApply}
          >
            {status === 'pending' || busy ? 'Editing…' : 'Apply edit'}
          </button>
        </>
      }
    >
      <div className="image-edit-dialog">
        <div className="image-edit-preview">
          {resultId ? (
            <img src={imageUrl(resultId)} alt="current" />
          ) : (
            <div className="artwork-thumb-empty">(no image)</div>
          )}
          {(status === 'pending' || busy) && (
            <div className="artwork-thumb-overlay">
              <div className="spinner" />
              <span>Editing…</span>
            </div>
          )}
        </div>
        <div className="image-edit-prompt">
          <label
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <span className="field-label">Edit prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='e.g. "add a red hat", "change the background to a forest"'
              disabled={status === 'pending' || busy}
              className="frame-generate-textarea"
              rows={4}
            />
          </label>
          <div className="frame-generate-model-row">
            <span className="field-label">Image model</span>
            <div className="frame-generate-model-options">
              {IMAGE_MODELS.map((m) => (
                <label key={m.id}>
                  <input
                    type="radio"
                    name="inline-image-edit-model"
                    value={m.id}
                    checked={imageModel === m.id}
                    onChange={() => setImageModel(m.id)}
                    disabled={status === 'pending' || busy}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
          <p className="frame-generate-help">
            The current image becomes "previous" so you can Undo one step.
            Closing this dialog while an edit is running is fine — the result
            appears in place when it's done.
          </p>
          {hasUndo && (
            <p className="frame-generate-help">
              Undo will revert to the immediately-preceding image and discard
              the current one. Only one step of history is kept.
            </p>
          )}
          {error && <div className="error-banner">{error}</div>}
        </div>
      </div>
    </Modal>
  );
}
