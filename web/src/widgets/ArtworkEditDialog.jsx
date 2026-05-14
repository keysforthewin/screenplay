import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiPostJson, imageUrl } from '../api.js';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.artworkEdit.model';

// In-line artwork editor. Strictly single-image image-to-image edits — the
// dialog feeds the artwork's current result_image_id as the input image plus
// the user's prompt and chosen model; the new result replaces the current one
// and the immediately-previous result is kept so the user can Undo one step.
//
// Lifecycle:
//   1. User types prompt → clicks Apply.
//   2. Dialog POSTs /<host>/<id>/artwork/<artworkId>/edit. The route flips
//      the artwork to status='pending' and returns immediately.
//   3. Dialog stays open showing a spinner. The parent re-renders when the
//      Hocuspocus fields_updated broadcast lands (CollabSurface →
//      onPing → setRefreshKey); the parent passes the fresh artwork doc
//      back in via `artwork` prop, so we see status flip to 'done' and
//      the new result_image_id.
//   4. Undo: synchronous POST .../undo → swaps previous → current.
//
// Props:
//   open, onClose, onDone (refresh callback)
//   hostType: 'character' | 'beat'
//   hostId:   24-hex string
//   artwork:  the latest artwork doc, re-passed each refresh by the parent
export function ArtworkEditDialog({
  open,
  onClose,
  onDone,
  hostType,
  hostId,
  artwork,
}) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const openSeqRef = useRef(0);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  const artworkId = artwork?._id?.toString?.() || (artwork?._id ? String(artwork._id) : null);
  const basePath = `/${hostType}/${hostId}/artwork/${artworkId}`;
  const status = artwork?.status || (artwork?.result_image_id ? 'done' : 'pending');
  const hasUndo = !!artwork?.previous_result_image_id;
  const resultId =
    artwork?.result_image_id?.toString?.()
    || (artwork?.result_image_id ? String(artwork.result_image_id) : null);

  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      return;
    }
    setPrompt('');
    setError(null);
    setBusy(false);
  }, [open, artworkId]);

  // When the broadcast lands and the artwork transitions out of pending
  // back to done (or error), drop the local `busy` indicator. We don't
  // close the dialog automatically — the user might want to iterate.
  useEffect(() => {
    if (!open) return;
    if (status !== 'pending' && busy) {
      setBusy(false);
      if (status === 'error') {
        setError(artwork?.error_message || 'Edit failed.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, open]);

  const canApply = prompt.trim().length > 0 && status !== 'pending' && !busy && !!artworkId;
  const canUndo = hasUndo && status !== 'pending' && !busy;

  async function applyEdit() {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      await apiPostJson(`${basePath}/edit`, { prompt: prompt.trim(), model: imageModel });
      // Don't close — wait for the broadcast to refresh the artwork doc
      // with the new image.
      await onDone?.();
      if (seq === openSeqRef.current) setPrompt('');
    } catch (e) {
      if (seq === openSeqRef.current) {
        setError(e?.message || 'Edit failed');
        setBusy(false);
      }
    }
  }

  async function undoEdit() {
    if (!canUndo) return;
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      await apiPostJson(`${basePath}/undo`, {});
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
      title="Edit artwork"
      onClose={onClose}
      dismissible={!busy && status !== 'pending'}
      size="wide"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
          <button
            type="button"
            onClick={undoEdit}
            disabled={!canUndo}
            title={hasUndo ? 'Revert the most recent edit' : 'Nothing to undo'}
          >
            Undo
          </button>
          <button
            type="button"
            className="primary"
            onClick={applyEdit}
            disabled={!canApply}
          >
            {status === 'pending' || busy ? 'Editing…' : 'Apply edit'}
          </button>
        </>
      }
    >
      <div className="artwork-edit-dialog">
        <div className="artwork-edit-preview">
          {resultId ? (
            <img src={imageUrl(resultId)} alt="current artwork" />
          ) : (
            <div className="artwork-thumb-empty">(no image)</div>
          )}
          {status === 'pending' && (
            <div className="artwork-thumb-overlay">
              <div className="spinner" />
              <span>Editing…</span>
            </div>
          )}
        </div>
        <div className="artwork-edit-prompt">
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
                    name="artwork-edit-image-model"
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
            appears in the gallery when it's done.
          </p>
          {hasUndo && (
            <p className="frame-generate-help">
              Undo will revert to the immediately-preceding image and
              discard the current one. Only one step of history is kept.
            </p>
          )}
          {error && <div className="error-banner">{error}</div>}
        </div>
      </div>
    </Modal>
  );
}
