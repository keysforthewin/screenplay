import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { apiGet, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.imagesheet.model';

// Beats target an approximate count for the LLM planner (characters use the
// checklist below instead of a count).
const BEAT_SHOT = { label: 'Target shots', def: 8, min: 3, max: 20 };

// "Create image sheet" dialog for the Artwork tab on characters AND beats.
// Characters: pick exactly which fixed shots to generate from a checklist.
// Beats: a dynamically-planned set of environment/background plates (a count).
// Starts a background job (POST returns a job id immediately); the dialog closes
// and the parent watches the job + the pending artwork tiles fill in live.
export function ImageSheetDialog({
  open,
  onClose,
  onStarted,
  hostType,
  hostId,
  hostLabel,
  hostImages = [],
  hostArtworks = [],
}) {
  const isCharacter = hostType === 'character';
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Character: the fixed shot list + which are checked.
  const [shots, setShots] = useState([]);
  const [selectedShots, setSelectedShots] = useState([]);
  // Beat: approximate target count.
  const [shotCount, setShotCount] = useState(BEAT_SHOT.def);
  const openSeqRef = useRef(0);

  const basePath = `/${hostType}/${hostId}`;

  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      return;
    }
    setError(null);
    setBusy(false);
    setReferenceIds([]);
    setShotCount(BEAT_SHOT.def);
  }, [open]);

  // Load the canonical character shot list when the dialog opens for a
  // character; default every shot to checked.
  useEffect(() => {
    if (!open || !isCharacter) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/character-sheet-shots');
        if (cancelled) return;
        const list = Array.isArray(r?.shots) ? r.shots : [];
        setShots(list);
        setSelectedShots(list.map((s) => s.name));
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Could not load the shot list');
      }
    })();
    return () => { cancelled = true; };
  }, [open, isCharacter]);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }

  function toggleShot(name) {
    setSelectedShots((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  }

  const count = Number(shotCount);
  const countValid = Number.isFinite(count) && count >= BEAT_SHOT.min && count <= BEAT_SHOT.max;
  const selectionValid = isCharacter ? selectedShots.length >= 1 : countValid;
  const canSubmit = selectionValid && IMAGE_MODEL_IDS.has(imageModel) && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const body = isCharacter
        ? { reference_image_ids: referenceIds, model: imageModel, shot_names: selectedShots }
        : { reference_image_ids: referenceIds, model: imageModel, shot_count: count };
      const res = await apiPostJson(`${basePath}/image-sheet`, body);
      if (seq !== openSeqRef.current) return;
      onStarted?.({ jobId: res.job_id, planned: res.planned ?? null });
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start image sheet');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  const intro = isCharacter
    ? 'Generate a set of clean, single-pose reference photos for this character — one image per checked shot. No text, no panels; just the pose.'
    : 'Plan and generate a set of scene and background plates for this beat in one background job — universal backdrops you can reuse later.';

  return (
    <>
      <Modal
        open={open}
        title="Create image sheet"
        onClose={onClose}
        dismissible={!busy}
        size="wide"
        footer={
          <>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              type="button"
              className="primary"
              onClick={submit}
              disabled={!canSubmit}
            >
              {busy
                ? 'Starting…'
                : isCharacter
                  ? `Generate ${selectedShots.length} image${selectedShots.length === 1 ? '' : 's'}`
                  : 'Generate sheet'}
            </button>
          </>
        }
      >
        <div className="frame-generate-modal">
          <p className="tab-intro" style={{ marginTop: 0 }}>{intro}</p>

          <div className="frame-generate-refs">
            <div className="frame-generate-section-header">
              <span className="field-label">Reference images</span>
              <button
                type="button"
                className="primary"
                onClick={() => setPickerOpen(true)}
                disabled={busy}
              >
                + Add references
              </button>
            </div>
            <div className="frame-generate-ref-grid">
              {referenceIds.length === 0 ? (
                <div className="frame-generate-ref-empty">
                  No reference images selected. Adding some anchors the likeness —
                  the generated images may drift without them.
                </div>
              ) : (
                referenceIds.map((id) => (
                  <div className="frame-generate-ref-thumb" key={id}>
                    <img
                      src={thumbUrl(id)}
                      alt="reference"
                      loading="lazy"
                      onClick={() => window.open(imageUrl(id), '_blank', 'noopener')}
                    />
                    <button
                      type="button"
                      className="storyboard-frame-remove"
                      title="Remove reference"
                      onClick={() => removeReference(id)}
                      disabled={busy}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {isCharacter ? (
            <div className="image-sheet-shotlist">
              <div className="frame-generate-section-header">
                <span className="field-label">
                  Shots to generate ({selectedShots.length}/{shots.length})
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setSelectedShots(shots.map((s) => s.name))} disabled={busy}>
                    All
                  </button>
                  <button type="button" onClick={() => setSelectedShots([])} disabled={busy}>
                    None
                  </button>
                </span>
              </div>
              <div className="image-sheet-shotlist-grid">
                {shots.map((s) => (
                  <label key={s.name} className="image-sheet-shot" title={s.hint || ''}>
                    <input
                      type="checkbox"
                      checked={selectedShots.includes(s.name)}
                      onChange={() => toggleShot(s.name)}
                      disabled={busy}
                    />
                    <span>{s.name}</span>
                  </label>
                ))}
              </div>
              <span className="frame-generate-help">
                Each checked shot is one image. Uncheck any you don't need —
                generation is billed per image.
              </span>
            </div>
          ) : (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12, maxWidth: 220 }}>
              <span className="field-label">{BEAT_SHOT.label}</span>
              <input
                type="number"
                min={BEAT_SHOT.min}
                max={BEAT_SHOT.max}
                value={shotCount}
                onChange={(e) => setShotCount(e.target.value)}
                disabled={busy}
              />
              <span className="frame-generate-help">
                The planner aims for about this many plates; the actual count may differ.
              </span>
            </label>
          )}

          <div className="frame-generate-model-row">
            <span className="field-label">Image model</span>
            <div className="frame-generate-model-options">
              {IMAGE_MODELS.map((m) => (
                <label key={m.id}>
                  <input
                    type="radio"
                    name="image-sheet-model"
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
            Generation runs in the background. The shots appear as placeholders in
            the gallery and fill in as each one finishes.
          </span>

          {error && <div className="error-banner">{error}</div>}
        </div>
      </Modal>
      <ArtworkReferencePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onApply={(ids) => setReferenceIds(ids)}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
        selectedIds={referenceIds}
      />
    </>
  );
}
