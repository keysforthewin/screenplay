import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { BeatMultiSelect } from './BeatMultiSelect.jsx';
import { MainBeatSelect } from './MainBeatSelect.jsx';
import { SetMultiSelect } from './SetMultiSelect.jsx';
import { apiGet, apiPostJson } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.autosheet.model';

// "Auto-Generate Images" for a set: one chained background job that plans a
// shot list, then renders every shot — no review step. Shots are planned for
// the chosen MAIN beat only; the other checked beats are read as continuity
// context. The checked reference sets' gallery images anchor the render.
// Progress reuses the ArtworkTab's sheet polling via onStarted.
export function AutoImageSheetDialog({ open, onClose, onStarted, hostId, hostLabel }) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [beats, setBeats] = useState(null); // null = loading
  const [mainBeatId, setMainBeatId] = useState('');
  const [contextIds, setContextIds] = useState([]);
  const [sets, setSets] = useState([]);
  const [referenceSetIds, setReferenceSetIds] = useState([]);
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
    setMainBeatId('');
    setContextIds([]);
    setSets([]);
    setReferenceSetIds([String(hostId)]);
    const seq = openSeqRef.current;
    (async () => {
      try {
        const [beatsRes, tocRes] = await Promise.all([
          apiGet(`/set/${hostId}/beats`),
          apiGet('/toc').catch(() => null),
        ]);
        if (seq !== openSeqRef.current) return;
        const list = Array.isArray(beatsRes?.beats) ? beatsRes.beats : [];
        setBeats(list);
        // Default: the first referencing beat is the main beat, the rest are
        // context. With no beats the plan runs from the description alone.
        setMainBeatId(list.length ? String(list[0]._id) : '');
        setContextIds(list.slice(1).map((b) => String(b._id)));
        setSets(Array.isArray(tocRes?.sets) ? tocRes.sets : []);
      } catch (e) {
        if (seq !== openSeqRef.current) return;
        setBeats([]);
        setError(e?.message || 'Could not load the beat list');
      }
    })();
  }, [open, hostId]);

  function changeMainBeat(id) {
    setMainBeatId(id);
    if (id) setContextIds((prev) => prev.filter((x) => x !== id));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const body = {
        model: imageModel,
        beat_ids: contextIds.filter((id) => id !== mainBeatId),
        reference_set_ids: referenceSetIds,
      };
      if (mainBeatId) body.main_beat_id = mainBeatId;
      const res = await apiPostJson(`/set/${hostId}/auto-image-sheet`, body);
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
  const contextBeats = (beats || []).filter((b) => String(b._id) !== mainBeatId);

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
          Plans images for what the main beat stages in{' '}
          {hostLabel ? <strong>{hostLabel}</strong> : 'this set'}, then renders
          every shot — no review step. Context beats are read for continuity
          only; the checked reference sets' galleries anchor the look.
        </p>
        {beats == null ? (
          <span className="frame-generate-help">Loading beats…</span>
        ) : (
          <>
            <MainBeatSelect
              beats={beats}
              value={mainBeatId}
              onChange={changeMainBeat}
              disabled={busy}
            />
            {(beats.length === 0 || contextBeats.length > 0) && (
              <BeatMultiSelect
                beats={contextBeats}
                selectedIds={contextIds}
                onChange={setContextIds}
                disabled={busy}
                label="Context beats (read for continuity — no images planned for them)"
              />
            )}
            <SetMultiSelect
              sets={sets}
              selectedIds={referenceSetIds}
              onChange={setReferenceSetIds}
              disabled={busy}
              currentSetId={hostId}
            />
          </>
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
