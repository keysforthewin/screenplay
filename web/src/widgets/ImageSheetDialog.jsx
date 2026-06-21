import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { GenerationProgress } from './GenerationProgress.jsx';
import { apiGet, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.imagesheet.model';

// "Create image sheet" dialog for the Artwork tab on characters AND beats.
// Characters: pick which fixed shots to generate from a checklist, then start a
// background job immediately.
// Beats: a wizard — Derive (a 2-phase LLM pass reads the beat and proposes
// scene/background plates, each with a justification + verbatim script quote) →
// Review (edit / remove / add the plates) → Generate sheet (renders the reviewed
// list through the same background job). justification/quote are review-only and
// are NOT sent to the image model.
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
  // Beat wizard: 'setup' → 'deriving' → 'review'.
  const [stage, setStage] = useState('setup');
  const [derivedShots, setDerivedShots] = useState([]); // [{ key, name, prompt, justification, quote }]
  const [deriveJob, setDeriveJob] = useState(null);
  const [showDeriveLog, setShowDeriveLog] = useState(false);
  const [editedSinceDerive, setEditedSinceDerive] = useState(false);
  const openSeqRef = useRef(0);
  const derivePollRef = useRef(null);
  const deriveLogRef = useRef(null);
  const keyRef = useRef(0);

  const basePath = `/${hostType}/${hostId}`;

  function stopDerivePoll() {
    if (derivePollRef.current) {
      clearInterval(derivePollRef.current);
      derivePollRef.current = null;
    }
  }

  // Reset on open/close. Closing bumps the seq so any in-flight async bails.
  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      stopDerivePoll();
      return;
    }
    setError(null);
    setBusy(false);
    setReferenceIds([]);
    setStage('setup');
    setDerivedShots([]);
    setDeriveJob(null);
    setShowDeriveLog(false);
    setEditedSinceDerive(false);
  }, [open]);

  useEffect(() => () => stopDerivePoll(), []);

  // Character shot list loads when the dialog opens for a character.
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

  function nextKey() {
    keyRef.current += 1;
    return `s${keyRef.current}`;
  }

  // ---- Character: start the render job immediately. ------------------------
  async function submitCharacter() {
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/image-sheet`, {
        reference_image_ids: referenceIds,
        model: imageModel,
        shot_names: selectedShots,
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

  // ---- Beat: derive (2-phase) → poll → review. ----------------------------
  async function pollDerive(jobId, seq) {
    if (seq !== openSeqRef.current) { stopDerivePoll(); return; }
    try {
      const r = await apiGet(`/image-sheet/${jobId}`);
      const job = r?.job ?? r;
      if (seq !== openSeqRef.current) { stopDerivePoll(); return; }
      setDeriveJob(job);
      if (job?.status === 'derived') {
        stopDerivePoll();
        const list = Array.isArray(job.shots) ? job.shots : [];
        setDerivedShots(list.map((s) => ({
          key: nextKey(),
          name: s.name || '',
          prompt: s.prompt || '',
          justification: s.justification || '',
          quote: s.quote || '',
        })));
        setEditedSinceDerive(false);
        setStage('review');
        setBusy(false);
      } else if (job?.status === 'error') {
        stopDerivePoll();
        setError(job.error || 'Derivation failed.');
        setStage('setup');
        setBusy(false);
      }
    } catch {
      // transient poll error — keep polling (the job runs server-side).
    }
  }

  async function derive() {
    setBusy(true);
    setError(null);
    setStage('deriving');
    setDeriveJob({ status: 'queued', started_at: new Date().toISOString(), events: [] });
    setShowDeriveLog(true);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/shot-plan`, { reference_image_ids: referenceIds });
      if (seq !== openSeqRef.current) return;
      stopDerivePoll();
      derivePollRef.current = setInterval(() => pollDerive(res.job_id, seq), 2000);
      pollDerive(res.job_id, seq);
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start derivation');
      setStage('setup');
      setBusy(false);
    }
  }

  function reDerive() {
    if (editedSinceDerive && !confirm('Re-derive will discard your edits to the shot list. Continue?')) return;
    setDerivedShots([]);
    derive();
  }

  function updateShot(key, field, value) {
    setEditedSinceDerive(true);
    setDerivedShots((prev) => prev.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  }

  function removeShot(key) {
    setEditedSinceDerive(true);
    setDerivedShots((prev) => prev.filter((s) => s.key !== key));
  }

  function addShot() {
    setEditedSinceDerive(true);
    setDerivedShots((prev) => [...prev, { key: nextKey(), name: 'New plate', prompt: '', justification: '', quote: '' }]);
  }

  async function generateSheet() {
    const ready = derivedShots
      .map((s) => ({ name: s.name.trim(), prompt: s.prompt.trim() }))
      .filter((s) => s.name && s.prompt);
    if (!ready.length) {
      setError('Add at least one plate with a name and a prompt.');
      return;
    }
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/image-sheet`, {
        reference_image_ids: referenceIds,
        model: imageModel,
        shots: ready,
      });
      if (seq !== openSeqRef.current) return;
      onStarted?.({ jobId: res.job_id, planned: res.planned ?? ready.length });
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start image sheet');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  // ---- Footer (varies by host type + beat stage). -------------------------
  const charCanSubmit = selectedShots.length >= 1 && IMAGE_MODEL_IDS.has(imageModel) && !busy;
  const reviewReady = derivedShots.some((s) => s.name.trim() && s.prompt.trim());

  let footer;
  if (isCharacter) {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="primary" onClick={submitCharacter} disabled={!charCanSubmit}>
          {busy ? 'Starting…' : `Generate ${selectedShots.length} image${selectedShots.length === 1 ? '' : 's'}`}
        </button>
      </>
    );
  } else if (stage === 'review') {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" onClick={reDerive} disabled={busy}>Re-derive</button>
        <button
          type="button"
          className="primary"
          onClick={generateSheet}
          disabled={busy || !reviewReady || !IMAGE_MODEL_IDS.has(imageModel)}
        >
          {busy ? 'Starting…' : `Generate sheet (${derivedShots.length})`}
        </button>
      </>
    );
  } else {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy && stage !== 'deriving'}>Cancel</button>
        <button type="button" className="primary" onClick={derive} disabled={busy}>
          {stage === 'deriving' ? 'Deriving…' : 'Derive shots'}
        </button>
      </>
    );
  }

  const intro = isCharacter
    ? 'Generate a set of clean, single-pose reference photos for this character — one image per checked shot. No text, no panels; just the pose.'
    : 'Derive a set of scene and background plates from this beat’s script, review and edit them, then generate. Plates are universal backdrops you can reuse later.';

  const modalSize = !isCharacter && stage === 'review' ? 'xl' : 'wide';

  return (
    <>
      <Modal
        open={open}
        title="Create image sheet"
        onClose={onClose}
        dismissible={!busy}
        size={modalSize}
        footer={footer}
      >
        <div className="frame-generate-modal">
          <p className="tab-intro" style={{ marginTop: 0 }}>{intro}</p>

          {(isCharacter || stage !== 'deriving') && (
            <div className="frame-generate-refs">
              <div className="frame-generate-section-header">
                <span className="field-label">Reference images</span>
                <button type="button" className="primary" onClick={() => setPickerOpen(true)} disabled={busy}>
                  + Add references
                </button>
              </div>
              <div className="frame-generate-ref-grid">
                {referenceIds.length === 0 ? (
                  <div className="frame-generate-ref-empty">
                    No reference images selected. Adding some anchors the look — the
                    generated plates may drift without them.
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
          )}

          {isCharacter && (
            <div className="image-sheet-shotlist">
              <div className="frame-generate-section-header">
                <span className="field-label">
                  Shots to generate ({selectedShots.length}/{shots.length})
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => setSelectedShots(shots.map((s) => s.name))} disabled={busy}>All</button>
                  <button type="button" onClick={() => setSelectedShots([])} disabled={busy}>None</button>
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
          )}

          {!isCharacter && stage === 'setup' && (
            <div className="image-sheet-derive-setup">
              <span className="frame-generate-help">
                Click <strong>Derive shots</strong> to read the beat and propose plates. You'll
                review and edit the list before any images are generated.
              </span>
            </div>
          )}

          {!isCharacter && stage === 'deriving' && deriveJob && (
            <div className="image-sheet-progress">
              <GenerationProgress
                job={deriveJob}
                noun="plate"
                showLog={showDeriveLog}
                onToggleLog={() => setShowDeriveLog((s) => !s)}
                logRef={deriveLogRef}
              />
            </div>
          )}

          {!isCharacter && stage === 'review' && (
            <div className="image-sheet-review">
              <div className="frame-generate-section-header">
                <span className="field-label">Plates to generate ({derivedShots.length})</span>
                <button type="button" onClick={addShot} disabled={busy}>+ Add plate</button>
              </div>
              {derivedShots.length === 0 ? (
                <div className="frame-generate-ref-empty">
                  No plates derived. Add one manually, or Re-derive.
                </div>
              ) : (
                <div className="image-sheet-plate-list">
                  {derivedShots.map((s, i) => (
                    <div className="image-sheet-plate-card" key={s.key}>
                      <div className="image-sheet-plate-head">
                        <span className="image-sheet-plate-num">{i + 1}</span>
                        <input
                          className="image-sheet-plate-name"
                          type="text"
                          value={s.name}
                          placeholder="Plate name"
                          onChange={(e) => updateShot(s.key, 'name', e.target.value)}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="storyboard-frame-remove"
                          title="Remove plate"
                          onClick={() => removeShot(s.key)}
                          disabled={busy}
                        >
                          ×
                        </button>
                      </div>
                      <textarea
                        className="image-sheet-plate-prompt"
                        rows={3}
                        value={s.prompt}
                        placeholder="Image prompt (purely visual — no characters or caption text)"
                        onChange={(e) => updateShot(s.key, 'prompt', e.target.value)}
                        disabled={busy}
                      />
                      {s.quote && <blockquote className="image-sheet-plate-quote">{s.quote}</blockquote>}
                      {s.justification && <div className="image-sheet-plate-just">{s.justification}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {(isCharacter || stage === 'setup' || stage === 'review') && (
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
          )}

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
