import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { imageUrl, thumbUrl } from '../api.js';
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
//   referenceIds:    optional string[] — when non-null, the "Reference images"
//                    section renders. Passed to applyEdit as well.
//   onPickReferences: () => void — wrapper opens its own picker
//   onRemoveReference: (id: string) => void
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
  referenceIds = null,
  onPickReferences = null,
  onRemoveReference = null,
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
      await applyEdit({
        prompt: prompt.trim(),
        model: imageModel,
        referenceIds: Array.isArray(referenceIds) ? referenceIds : [],
      });
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
          {Array.isArray(referenceIds) && onPickReferences && (
            <div className="frame-generate-refs" style={{ marginTop: 12 }}>
              <div className="frame-generate-section-header">
                <span className="field-label">Reference images</span>
                <button
                  type="button"
                  className="primary"
                  onClick={onPickReferences}
                  disabled={status === 'pending' || busy}
                >
                  + Add references
                </button>
              </div>
              <div className="frame-generate-ref-grid">
                {resultId && (
                  <div
                    className="frame-generate-ref-thumb is-locked"
                    key={`primary:${resultId}`}
                    title="The image being edited — always passed to the model as reference #1 and can't be removed."
                  >
                    <img
                      src={thumbUrl(resultId)}
                      alt="current image (reference #1)"
                      loading="lazy"
                      onClick={() =>
                        window.open(imageUrl(resultId), '_blank', 'noopener')
                      }
                    />
                    <span
                      className="ref-index-badge"
                      style={{
                        position: 'absolute',
                        top: 4,
                        left: 4,
                        background: 'var(--accent, #4a90e2)',
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 6px',
                        borderRadius: 4,
                        pointerEvents: 'none',
                      }}
                    >
                      1 · current
                    </span>
                  </div>
                )}
                {referenceIds.map((id, idx) => (
                  <div className="frame-generate-ref-thumb" key={id}>
                    <img
                      src={thumbUrl(id)}
                      alt="reference"
                      loading="lazy"
                      onClick={() =>
                        window.open(imageUrl(id), '_blank', 'noopener')
                      }
                    />
                    <span
                      className="ref-index-badge"
                      style={{
                        position: 'absolute',
                        top: 4,
                        left: 4,
                        background: 'rgba(0,0,0,0.6)',
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 6px',
                        borderRadius: 4,
                        pointerEvents: 'none',
                      }}
                    >
                      {idx + 2}
                    </span>
                    {onRemoveReference && (
                      <button
                        type="button"
                        className="storyboard-frame-remove"
                        title="Remove reference"
                        onClick={() => onRemoveReference(id)}
                        disabled={status === 'pending' || busy}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {!resultId && referenceIds.length === 0 && (
                  <div className="frame-generate-ref-empty">
                    Optional. Attach images the model can incorporate into the
                    current image during this edit.
                  </div>
                )}
              </div>
              {resultId && (
                <p
                  className="frame-generate-help"
                  style={{ marginTop: 6 }}
                >
                  The current image is always sent as reference #1. Any extra
                  images you add are passed as additional references starting at
                  #2.
                </p>
              )}
            </div>
          )}
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
