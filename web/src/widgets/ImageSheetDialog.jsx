import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { apiPostJson, imageUrl, thumbUrl } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.imagesheet.model';

// Per-host shot-count config. Characters use a fixed preset (max = preset
// length, 11); beats target an approximate count for the LLM planner.
const SHOT_CONFIG = {
  character: { label: 'Shots', def: 11, min: 1, max: 11 },
  beat: { label: 'Target shots', def: 8, min: 3, max: 20 },
};

// "Create image sheet" dialog for the Artwork tab on characters AND beats.
// Starts a long-running batch job: characters get a fixed portrait/turnaround
// set; beats get a dynamically-planned set of environment/background plates.
// The submit POSTs to /{hostType}/{hostId}/image-sheet which returns a job id
// immediately (202). The dialog closes on success and the parent watches the
// job + the pending artwork tiles fill in live.
//
// Props:
//   onStarted({ jobId, planned }): called after a successful start.
//   hostType, hostId, hostLabel, hostImages, hostArtworks: as for ArtworkDialog.
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
  const cfg = SHOT_CONFIG[hostType] || SHOT_CONFIG.character;
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [shotCount, setShotCount] = useState(cfg.def);
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
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
    setShotCount(cfg.def);
  }, [open, cfg.def]);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }

  const count = Number(shotCount);
  const countValid = Number.isFinite(count) && count >= cfg.min && count <= cfg.max;
  const canSubmit = countValid && IMAGE_MODEL_IDS.has(imageModel) && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/image-sheet`, {
        reference_image_ids: referenceIds,
        model: imageModel,
        shot_count: count,
      });
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

  const intro =
    hostType === 'character'
      ? 'Generate a full set of portrait, profile and turnaround shots for this character in one background job — a reusable reference sheet.'
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
              {busy ? 'Starting…' : 'Generate sheet'}
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
                  No reference images selected. Adding some anchors the look — the
                  generated images may drift without them.
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

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12, maxWidth: 220 }}>
            <span className="field-label">{cfg.label}</span>
            <input
              type="number"
              min={cfg.min}
              max={cfg.max}
              value={shotCount}
              onChange={(e) => setShotCount(e.target.value)}
              disabled={busy}
            />
            <span className="frame-generate-help">
              {hostType === 'character'
                ? `Fixed turnaround/portrait set (up to ${cfg.max}). Lower for a quicker partial sheet.`
                : `The planner aims for about this many plates; the actual count may differ.`}
            </span>
          </label>

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
