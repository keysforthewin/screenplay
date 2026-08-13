import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { BeatMultiSelect } from './BeatMultiSelect.jsx';
import { apiGet, apiPostJson } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.autosheet.model';

// "Auto-Generate Images" for a set: one chained background job that plans a
// shot list from the selected beats' text + the set's description (the LLM
// decides how many shots the text demands), then renders every shot — no
// review step. Progress reuses the ArtworkTab's sheet polling via onStarted.
export function AutoImageSheetDialog({ open, onClose, onStarted, hostId, hostLabel }) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [beats, setBeats] = useState(null); // null = loading
  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const openSeqRef = useRef(0);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      return;
    }
    setError(null);
    setBusy(false);
    setBeats(null);
    setSelectedIds([]);
    const seq = openSeqRef.current;
    (async () => {
      try {
        const r = await apiGet(`/set/${hostId}/beats`);
        if (seq !== openSeqRef.current) return;
        const list = Array.isArray(r?.beats) ? r.beats : [];
        setBeats(list);
        setSelectedIds(list.map((b) => b._id));
      } catch (e) {
        if (seq !== openSeqRef.current) return;
        setBeats([]);
        setError(e?.message || 'Could not load the beat list');
      }
    })();
  }, [open, hostId]);

  async function submit() {
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`/set/${hostId}/auto-image-sheet`, {
        model: imageModel,
        beat_ids: selectedIds,
      });
      if (seq !== openSeqRef.current) return;
      onStarted?.({ jobId: res.job_id, planned: res.planned ?? null });
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start auto-generation');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  const canSubmit = beats != null && !busy && IMAGE_MODEL_IDS.has(imageModel);

  return (
    <Modal
      open={open}
      title="Auto-Generate Images"
      onClose={onClose}
      dismissible={!busy}
      size="wide"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={submit} disabled={!canSubmit}>
            {busy ? 'Starting…' : 'Auto-generate'}
          </button>
        </>
      }
    >
      <div className="frame-generate-modal">
        <p className="tab-intro" style={{ marginTop: 0 }}>
          Plans a shot list from the selected beats and{' '}
          {hostLabel ? <strong>{hostLabel}</strong> : 'this set'}'s description,
          then renders every shot — no review step. How many shots is decided
          from the text itself. The set's gallery images are used as references.
        </p>
        {beats == null ? (
          <span className="frame-generate-help">Loading beats…</span>
        ) : (
          <BeatMultiSelect
            beats={beats}
            selectedIds={selectedIds}
            onChange={setSelectedIds}
            disabled={busy}
          />
        )}
        <div className="frame-generate-model-row">
          <span className="field-label">Image model</span>
          <div className="frame-generate-model-options">
            {IMAGE_MODELS.map((m) => (
              <label key={m.id}>
                <input
                  type="radio"
                  name="auto-sheet-model"
                  value={m.id}
                  checked={imageModel === m.id}
                  onChange={() => setImageModel(m.id)}
                  disabled={busy}
                />
                {m.label}
              </label>
            ))}
          </div>
        </div>
        <span className="frame-generate-help">
          Generation runs in the background. Planned shots appear as
          placeholders in the gallery and fill in as each one finishes.
        </span>
        {error && <div className="error-banner">{error}</div>}
      </div>
    </Modal>
  );
}
