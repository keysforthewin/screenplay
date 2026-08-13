import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { BeatMultiSelect } from './BeatMultiSelect.jsx';
import { MainBeatSelect } from './MainBeatSelect.jsx';
import { SetMultiSelect } from './SetMultiSelect.jsx';
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
  const isSet = hostType === 'set';
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  // Sets only: plates are planned for the main beat; the other checked beats
  // feed the derive context (default: main = first referencing beat, context =
  // the rest). The checked reference sets' galleries join the render refs.
  const [setBeats, setSetBeats] = useState(null);
  const [mainBeatId, setMainBeatId] = useState('');
  const [selectedBeatIds, setSelectedBeatIds] = useState([]);
  const [allSets, setAllSets] = useState([]);
  const [referenceSetIds, setReferenceSetIds] = useState([]);
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
      setPickerOpen(false);
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
    // Reference images are required for characters and beats, so open the
    // picker immediately. Sets default to their own gallery via the checked
    // reference sets, so the picker stays optional there.
    setPickerOpen(!isSet);
  }, [open, isSet]);

  useEffect(() => () => stopDerivePoll(), []);

  // Sets: load the referencing beats (main-beat select + context multi-select)
  // and the project's sets (reference-sets multi-select).
  useEffect(() => {
    if (!open || !isSet) return;
    let cancelled = false;
    setSetBeats(null);
    setMainBeatId('');
    setSelectedBeatIds([]);
    setAllSets([]);
    setReferenceSetIds([String(hostId)]);
    (async () => {
      try {
        const [beatsRes, tocRes] = await Promise.all([
          apiGet(`/set/${hostId}/beats`),
          apiGet('/toc').catch(() => null),
        ]);
        if (cancelled) return;
        const list = Array.isArray(beatsRes?.beats) ? beatsRes.beats : [];
        setSetBeats(list);
        setMainBeatId(list.length ? String(list[0]._id) : '');
        setSelectedBeatIds(list.slice(1).map((b) => String(b._id)));
        setAllSets(Array.isArray(tocRes?.sets) ? tocRes.sets : []);
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
    if (!hasReferences) {
      setError(isSet
        ? 'Select at least one reference image or check a reference set before deriving plates.'
        : 'Select at least one reference image before deriving plates.');
      return;
    }
    setBusy(true);
    setError(null);
    setStage('deriving');
    setDeriveJob({ status: 'queued', started_at: new Date().toISOString(), events: [] });
    setShowDeriveLog(true);
    const seq = openSeqRef.current;
    try {
      const body = { reference_image_ids: referenceIds };
      if (isSet) {
        body.beat_ids = selectedBeatIds.filter((id) => id !== mainBeatId);
        body.reference_set_ids = referenceSetIds;
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

  function addShot() {
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
    if (!hasReferences) {
      setError(isSet
        ? 'Select at least one reference image or check a reference set before generating.'
        : 'Select at least one reference image before generating.');
      return;
    }
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      const body = {
        reference_image_ids: referenceIds,
        model: imageModel,
        shots: ready,
      };
      if (isSet) body.reference_set_ids = referenceSetIds;
      const res = await apiPostJson(`${basePath}/image-sheet`, body);
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
  const hasReferences = referenceIds.length > 0 || (isSet && referenceSetIds.length > 0);
  const charCanSubmit = selectedShots.length >= 1 && hasReferences && IMAGE_MODEL_IDS.has(imageModel) && !busy;
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
          disabled={busy || !reviewReady || !hasReferences || !IMAGE_MODEL_IDS.has(imageModel)}
        >
          {busy ? 'Starting…' : `Generate sheet (${derivedShots.length})`}
        </button>
      </>
    );
  } else {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy && stage !== 'deriving'}>Cancel</button>
        <button type="button" className="primary" onClick={() => derive()} disabled={busy || !hasReferences}>
          {stage === 'deriving' ? 'Deriving…' : 'Derive shots'}
        </button>
      </>
    );
  }

  const intro = isCharacter
    ? 'Generate a set of clean, single-pose reference photos for this character — one image per checked shot. No text, no panels; just the pose.'
    : isSet
      ? 'Derive location plates for what the main beat stages in this set (context beats are read for continuity), review and edit them, then generate. Plates are universal backdrops reused as storyboard references.'
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
                    {isSet ? (
                      <>
                        No individual references picked — the checked reference sets
                        below supply the gallery images that anchor the look. Use{' '}
                        <strong>+ Add references</strong> to pin specific images too.
                      </>
                    ) : (
                      <>
                        At least one reference image is required — they anchor the look so
                        generation matches your subject instead of inventing random people.
                        Use <strong>+ Add references</strong> to choose some.
                      </>
                    )}
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
              <SetMultiSelect
                sets={allSets}
                selectedIds={referenceSetIds}
                onChange={setReferenceSetIds}
                disabled={busy}
                currentSetId={hostId}
              />
            </>
          )}

          {!isCharacter && stage === 'setup' && (
            <div className="image-sheet-derive-setup">
              <span className="frame-generate-help">
                {isSet
                  ? 'Click Derive shots to read the set’s description and the main beat (plus context beats), then propose plates. You’ll review and edit the list before any images are generated.'
                  : 'Click Derive shots to read the beat and propose plates. You’ll review and edit the list before any images are generated.'}
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
