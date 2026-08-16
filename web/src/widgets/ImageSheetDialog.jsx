import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { SheetReferencePicker } from './SheetReferencePicker.jsx';
import { BeatMultiSelect } from './BeatMultiSelect.jsx';
import { MainBeatSelect } from './MainBeatSelect.jsx';
import { GenerationProgress } from './GenerationProgress.jsx';
import { apiGet, apiPostJson, apiPutJson, imageUrl, thumbUrl } from '../api.js';
import { readStoredCatalogModel, writeStoredImageModel } from './imageModels.js';
import { ImageModelSelect } from './ImageModelSelect.jsx';

const MODEL_STORAGE_KEY = 'screenplay.imagesheet.model';
const REFS_MODEL_STORAGE_KEY = 'screenplay.imagesheet.refsmodel';

// "Create image sheet" dialog for the Artwork tab on characters, beats & sets.
// Characters: pick which fixed shots to generate from a checklist, then start a
// background job immediately (references + a single model, chosen up front).
// Beats/sets: a wizard — Derive (a 2-phase LLM pass reads the text and proposes
// plates, each marked with whether it REQUIRES a reference image) → Review
// (edit plates, assign a reference to every plate that requires one, pick the
// model(s)) → Generate. A mixed sheet renders on two models: one for plates
// with references (refs-capable) and one for prompt-only plates; each shot is
// sent with its own model. justification/quote are review-only and are NOT
// sent to the image model.
export function ImageSheetDialog({
  open,
  onClose,
  onStarted,
  hostType,
  hostId,
  hostLabel,
}) {
  const isCharacter = hostType === 'character';
  const isSet = hostType === 'set';
  // imageModel renders character sheets AND (beats/sets) the prompt-only
  // plates; refsModel renders the plates that carry references.
  const [imageModel, setImageModel] = useState(() => readStoredCatalogModel(MODEL_STORAGE_KEY));
  const [refsModel, setRefsModel] = useState(() => readStoredCatalogModel(REFS_MODEL_STORAGE_KEY));
  // Sets only: plates are planned for the main beat; the other checked beats
  // feed the derive context (default: main = first referencing beat, context =
  // the rest).
  const [setBeats, setSetBeats] = useState(null);
  const [mainBeatId, setMainBeatId] = useState('');
  const [selectedBeatIds, setSelectedBeatIds] = useState([]);
  // Characters only: the shared reference pool every shot renders with.
  const [referenceIds, setReferenceIds] = useState([]);
  // Which reference picker is open: null (closed), 'sheet' (the character
  // pool), or a plate key (that plate's own reference assignment).
  const [pickerTarget, setPickerTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Character: the fixed shot list + which are checked.
  const [shots, setShots] = useState([]);
  const [selectedShots, setSelectedShots] = useState([]);
  // Beat wizard: 'setup' → 'deriving' → 'review'.
  const [stage, setStage] = useState('setup');
  // [{ key, name, prompt, justification, quote, requiresReference, referenceIds }]
  const [derivedShots, setDerivedShots] = useState([]);
  const [deriveJob, setDeriveJob] = useState(null);
  const [showDeriveLog, setShowDeriveLog] = useState(false);
  // Re-derive feedback popup: the user says what to change; it's sent as
  // `direction` and the current plates as `previous_plates` so the planner revises.
  const [reDeriveOpen, setReDeriveOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
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
      setPickerTarget(null);
      return;
    }
    setError(null);
    setBusy(false);
    setReferenceIds([]);
    setStage('setup');
    setDerivedShots([]);
    setDeriveJob(null);
    setShowDeriveLog(false);
    setReDeriveOpen(false);
    setFeedback('');
    // Character sheets need references up front (they anchor the face), so
    // open the picker immediately. Beat/set references are assigned per plate
    // at the review stage.
    setPickerTarget(isCharacter ? 'sheet' : null);
  }, [open, isCharacter]);

  useEffect(() => () => stopDerivePoll(), []);

  // Sets: load the referencing beats (main-beat select + context multi-select).
  useEffect(() => {
    if (!open || !isSet) return;
    let cancelled = false;
    setSetBeats(null);
    setMainBeatId('');
    setSelectedBeatIds([]);
    (async () => {
      try {
        const beatsRes = await apiGet(`/set/${hostId}/beats`);
        if (cancelled) return;
        const list = Array.isArray(beatsRes?.beats) ? beatsRes.beats : [];
        setSetBeats(list);
        setMainBeatId(list.length ? String(list[0]._id) : '');
        setSelectedBeatIds(list.slice(1).map((b) => String(b._id)));
      } catch {
        if (!cancelled) setSetBeats([]); // derive still works, description-only
      }
    })();
    return () => { cancelled = true; };
  }, [open, isSet, hostId]);

  function changeMainBeat(id) {
    setMainBeatId(id);
    if (id) setSelectedBeatIds((prev) => prev.filter((x) => x !== id));
  }

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

  useEffect(() => {
    writeStoredImageModel(REFS_MODEL_STORAGE_KEY, refsModel);
  }, [refsModel]);

  // Project-level model defaults (About page → Models tab). Applied over the
  // localStorage prefill on open; the split selectors write changes back so
  // the choice is restored on every visit, for every collaborator. The ready
  // flag keeps the selectors' own fallback-to-first-eligible from clobbering
  // the stored defaults before they load.
  const defaultsReadyRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    defaultsReadyRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/model-defaults');
        if (cancelled) return;
        const d = r?.model_defaults || {};
        if (d.image_with_refs) setRefsModel(d.image_with_refs);
        if (d.image_prompt_only && !isCharacter) setImageModel(d.image_prompt_only);
      } catch {
        // No defaults endpoint / network hiccup — localStorage prefill stands.
      }
      if (!cancelled) defaultsReadyRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [open, isCharacter]);

  function changeRefsModel(id) {
    setRefsModel(id);
    if (defaultsReadyRef.current && id) {
      apiPutJson('/model-defaults', { image_with_refs: id }).catch(() => {});
    }
  }

  function changePromptModel(id) {
    setImageModel(id);
    if (defaultsReadyRef.current && id) {
      apiPutJson('/model-defaults', { image_prompt_only: id }).catch(() => {});
    }
  }

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
    if (referenceIds.length === 0) {
      setError('Select at least one reference image before generating.');
      return;
    }
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
          requiresReference: Boolean(s.requires_reference),
          referenceIds: Array.isArray(s.reference_image_ids) ? s.reference_image_ids.map(String) : [],
        })));
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

  async function derive({ direction = '', previousPlates = null } = {}) {
    setBusy(true);
    setError(null);
    setStage('deriving');
    setDeriveJob({ status: 'queued', started_at: new Date().toISOString(), events: [] });
    setShowDeriveLog(true);
    const seq = openSeqRef.current;
    try {
      const body = {};
      if (isSet) {
        body.beat_ids = selectedBeatIds.filter((id) => id !== mainBeatId);
        if (mainBeatId) body.main_beat_id = mainBeatId;
      }
      if (direction.trim()) body.direction = direction.trim();
      if (previousPlates && previousPlates.length) body.previous_plates = previousPlates;
      const res = await apiPostJson(`${basePath}/shot-plan`, body);
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

  // Re-derive opens a popup asking what to change; submitting sends that feedback
  // plus the current plates so the planner revises rather than re-rolls.
  function reDerive() {
    setFeedback('');
    setReDeriveOpen(true);
  }

  function submitReDerive() {
    const previousPlates = derivedShots
      .map((s) => ({ name: s.name.trim(), prompt: s.prompt.trim() }))
      .filter((s) => s.name && s.prompt);
    setReDeriveOpen(false);
    setDerivedShots([]);
    derive({ direction: feedback, previousPlates });
  }

  function updateShot(key, field, value) {
    setDerivedShots((prev) => prev.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  }

  function removeShot(key) {
    setDerivedShots((prev) => prev.filter((s) => s.key !== key));
  }

  function removePlateReference(key, id) {
    setDerivedShots((prev) =>
      prev.map((s) => (s.key === key ? { ...s, referenceIds: s.referenceIds.filter((x) => x !== id) } : s)),
    );
  }

  // The one picker serves both the character pool and a single plate's own
  // assignment, depending on which target opened it.
  function applyPickedReferences(ids) {
    if (pickerTarget === 'sheet') setReferenceIds(ids);
    else if (pickerTarget) updateShot(pickerTarget, 'referenceIds', ids);
  }

  function addShot() {
    setDerivedShots((prev) => [...prev, {
      key: nextKey(),
      name: 'New plate',
      prompt: '',
      justification: '',
      quote: '',
      requiresReference: false,
      referenceIds: [],
    }]);
  }

  // ---- Review-stage validation: which model(s) does this sheet need? -------
  const validPlates = derivedShots.filter((s) => s.name.trim() && s.prompt.trim());
  // Plates marked "requires reference" that still have none — Generate blocks
  // until each gets one (or the marking is unchecked).
  const missingRequired = validPlates.filter((s) => s.requiresReference && s.referenceIds.length === 0);
  // A plate renders on the refs model as soon as it carries references (a
  // requires-reference plate will, once its reference is assigned).
  const needRefsModel = validPlates.some((s) => s.referenceIds.length > 0 || s.requiresReference);
  const needPromptModel = validPlates.some((s) => s.referenceIds.length === 0 && !s.requiresReference);

  async function generateSheet() {
    if (!validPlates.length) {
      setError('Add at least one plate with a name and a prompt.');
      return;
    }
    if (missingRequired.length) {
      setError(`Assign a reference image to: ${missingRequired.map((s) => `"${s.name.trim()}"`).join(', ')} — or untick "Requires reference".`);
      return;
    }
    if (needRefsModel && !refsModel) {
      setError('Pick the model for plates with references.');
      return;
    }
    if (needPromptModel && !imageModel) {
      setError('Pick the model for prompt-only plates.');
      return;
    }
    const ready = validPlates.map((s) => ({
      name: s.name.trim(),
      prompt: s.prompt.trim(),
      reference_image_ids: s.referenceIds,
      model: s.referenceIds.length > 0 ? refsModel : imageModel,
    }));
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/image-sheet`, {
        model: needPromptModel ? imageModel : refsModel,
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
  const charCanSubmit = selectedShots.length >= 1 && referenceIds.length > 0 && Boolean(imageModel) && !busy;
  const reviewCanGenerate =
    validPlates.length > 0 &&
    missingRequired.length === 0 &&
    (!needRefsModel || Boolean(refsModel)) &&
    (!needPromptModel || Boolean(imageModel));

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
          disabled={busy || !reviewCanGenerate}
        >
          {busy ? 'Starting…' : `Generate sheet (${derivedShots.length})`}
        </button>
      </>
    );
  } else {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy && stage !== 'deriving'}>Cancel</button>
        <button type="button" className="primary" onClick={() => derive()} disabled={busy}>
          {stage === 'deriving' ? 'Deriving…' : 'Derive shots'}
        </button>
      </>
    );
  }

  const intro = isCharacter
    ? 'Generate a set of clean, single-pose reference photos for this character — one image per checked shot. No text, no panels; just the pose.'
    : isSet
      ? 'Derive location plates for what the main beat stages in this set (context beats are read for continuity). Each plate is marked with whether it needs a reference image — you assign those, pick the model(s), then generate.'
      : 'Derive scene and background plates from this beat’s script. Each plate is marked with whether it needs a reference image — you assign those, pick the model(s), then generate.';

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

          {isCharacter && (
            <div className="frame-generate-refs">
              <div className="frame-generate-section-header">
                <span className="field-label">Reference images</span>
                <button type="button" className="primary" onClick={() => setPickerTarget('sheet')} disabled={busy}>
                  + Add references
                </button>
              </div>
              <div className="frame-generate-ref-grid">
                {referenceIds.length === 0 ? (
                  <div className="frame-generate-ref-empty">
                    At least one reference image is required — they anchor the look so
                    generation matches your subject instead of inventing random people.
                    Use <strong>+ Add references</strong> to choose some.
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

          {isSet && stage === 'setup' && setBeats != null && (
            <>
              <MainBeatSelect
                beats={setBeats}
                value={mainBeatId}
                onChange={changeMainBeat}
                disabled={busy}
              />
              {(setBeats.length === 0 || setBeats.some((b) => String(b._id) !== mainBeatId)) && (
                <BeatMultiSelect
                  beats={setBeats.filter((b) => String(b._id) !== mainBeatId)}
                  selectedIds={selectedBeatIds}
                  onChange={setSelectedBeatIds}
                  disabled={busy}
                  label="Context beats (read for continuity — no plates planned for them)"
                />
              )}
            </>
          )}

          {!isCharacter && stage === 'setup' && (
            <div className="image-sheet-derive-setup">
              <span className="frame-generate-help">
                {isSet
                  ? 'Click Derive shots to read the set’s description and the main beat (plus context beats), then propose plates. You’ll assign references and pick the model(s) at the review step.'
                  : 'Click Derive shots to read the beat and propose plates. You’ll assign references and pick the model(s) at the review step.'}
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
                  {derivedShots.map((s, i) => {
                    const refMissing = s.requiresReference && s.referenceIds.length === 0;
                    return (
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
                          <label className="image-sheet-plate-reqref" title="Plates that depict an established look must render with a reference image.">
                            <input
                              type="checkbox"
                              checked={s.requiresReference}
                              onChange={(e) => updateShot(s.key, 'requiresReference', e.target.checked)}
                              disabled={busy}
                            />
                            <span>Requires reference</span>
                          </label>
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
                        <div className={`image-sheet-plate-refs${refMissing ? ' required-missing' : ''}`}>
                          {s.referenceIds.length === 0 ? (
                            <span className="image-sheet-plate-refs-label">
                              {refMissing
                                ? 'Reference required — use + Refs to assign one.'
                                : 'No references — renders from the prompt alone.'}
                            </span>
                          ) : (
                            s.referenceIds.map((id) => (
                              <div className="frame-generate-ref-thumb" key={id}>
                                <img
                                  src={thumbUrl(id)}
                                  alt="plate reference"
                                  loading="lazy"
                                  onClick={() => window.open(imageUrl(id), '_blank', 'noopener')}
                                />
                                <button
                                  type="button"
                                  className="storyboard-frame-remove"
                                  title="Remove reference from this plate"
                                  onClick={() => removePlateReference(s.key, id)}
                                  disabled={busy}
                                >
                                  ×
                                </button>
                              </div>
                            ))
                          )}
                          <button type="button" onClick={() => setPickerTarget(s.key)} disabled={busy}>
                            + Refs
                          </button>
                        </div>
                        {s.quote && <blockquote className="image-sheet-plate-quote">{s.quote}</blockquote>}
                        {s.justification && <div className="image-sheet-plate-just">{s.justification}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {isCharacter && (
            <div className="frame-generate-model-row">
              <span className="field-label">Image model</span>
              <ImageModelSelect
                value={imageModel}
                onChange={setImageModel}
                disabled={busy}
                compact
              />
            </div>
          )}

          {!isCharacter && stage === 'review' && (needRefsModel || needPromptModel) && (
            <div className="image-sheet-model-split">
              {needRefsModel && (
                <div className="frame-generate-model-row">
                  <span className="field-label">
                    Model for plates with references
                    {needPromptModel ? '' : ' (all plates)'}
                  </span>
                  <ImageModelSelect
                    value={refsModel}
                    onChange={changeRefsModel}
                    disabled={busy}
                    compact
                    requireReferences
                  />
                </div>
              )}
              {needPromptModel && (
                <div className="frame-generate-model-row">
                  <span className="field-label">
                    Model for prompt-only plates
                    {needRefsModel ? '' : ' (all plates)'}
                  </span>
                  <ImageModelSelect
                    value={imageModel}
                    onChange={changePromptModel}
                    disabled={busy}
                    compact
                    promptOnly
                  />
                </div>
              )}
            </div>
          )}

          <span className="frame-generate-help">
            Generation runs in the background. The shots appear as placeholders in
            the gallery and fill in as each one finishes.
          </span>

          {error && <div className="error-banner">{error}</div>}
        </div>
      </Modal>
      <SheetReferencePicker
        open={pickerTarget != null}
        onClose={() => setPickerTarget(null)}
        onApply={applyPickedReferences}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        beatIds={isSet ? [mainBeatId, ...selectedBeatIds].filter(Boolean) : []}
        selectedIds={
          pickerTarget && pickerTarget !== 'sheet'
            ? derivedShots.find((s) => s.key === pickerTarget)?.referenceIds || []
            : referenceIds
        }
      />
      <Modal
        open={reDeriveOpen}
        title="Re-derive plates"
        onClose={() => setReDeriveOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setReDeriveOpen(false)}>Cancel</button>
            <button type="button" className="primary" onClick={submitReDerive}>Re-derive</button>
          </>
        }
      >
        <div className="frame-generate-modal">
          <p className="tab-intro" style={{ marginTop: 0 }}>
            What should change? Tell the planner what didn't work about the current plates or what
            you'd like different — it will revise the set using your feedback. The current list (and
            any edits) will be replaced.
          </p>
          <textarea
            className="image-sheet-feedback"
            rows={5}
            autoFocus
            value={feedback}
            placeholder="e.g. Fewer wide shots, more interior set-detail inserts; grittier, rain-soaked mood."
            onChange={(e) => setFeedback(e.target.value)}
          />
        </div>
      </Modal>
    </>
  );
}
