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

// "Tune image sheet for storyboard" — a beat-only second pass at the image sheet.
// Flow: prefill the reference set (the one used for the initial sheet, editable)
// → Scan storyboard (a per-shot LLM pass proposes only the plates the storyboard
// still needs) → Review (edit / remove / add) → Generate (reuses the normal
// /beat/:id/image-sheet render path). Proposed plates never duplicate existing ones.
export function TuneImageSheetDialog({
  open,
  onClose,
  onStarted,
  hostId,
  hostLabel,
  hostImages = [],
  hostArtworks = [],
}) {
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // 'setup' → 'scanning' → 'review' | 'empty'.
  const [stage, setStage] = useState('setup');
  const [proposedShots, setProposedShots] = useState([]);
  const [scanJob, setScanJob] = useState(null);
  const [showScanLog, setShowScanLog] = useState(false);
  const openSeqRef = useRef(0);
  const scanPollRef = useRef(null);
  const scanLogRef = useRef(null);
  const keyRef = useRef(0);

  const basePath = `/beat/${hostId}`;

  function stopScanPoll() {
    if (scanPollRef.current) { clearInterval(scanPollRef.current); scanPollRef.current = null; }
  }

  // Reset + prefill on open; bump seq on close so in-flight async bails.
  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      stopScanPoll();
      setPickerOpen(false);
      return;
    }
    setError(null);
    setBusy(false);
    setStage('setup');
    setProposedShots([]);
    setScanJob(null);
    setShowScanLog(false);
    setReferenceIds([]);
    const seq = ++openSeqRef.current;
    (async () => {
      try {
        const r = await apiGet(`${basePath}/image-sheet-references`);
        if (seq !== openSeqRef.current) return;
        setReferenceIds(Array.isArray(r?.reference_ids) ? r.reference_ids.map(String) : []);
      } catch {
        // leave empty — the user can add references manually.
      }
    })();
  }, [open]);

  useEffect(() => () => stopScanPoll(), []);
  useEffect(() => { writeStoredImageModel(MODEL_STORAGE_KEY, imageModel); }, [imageModel]);

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }
  function nextKey() { keyRef.current += 1; return `t${keyRef.current}`; }

  async function pollScan(jobId, seq) {
    if (seq !== openSeqRef.current) { stopScanPoll(); return; }
    try {
      const r = await apiGet(`/image-sheet/${jobId}`);
      const job = r?.job ?? r;
      if (seq !== openSeqRef.current) { stopScanPoll(); return; }
      setScanJob(job);
      if (job?.status === 'derived') {
        stopScanPoll();
        const list = Array.isArray(job.shots) ? job.shots : [];
        setProposedShots(list.map((s) => ({
          key: nextKey(),
          name: s.name || '',
          prompt: s.prompt || '',
          justification: s.justification || '',
          quote: s.quote || '',
        })));
        setStage(list.length ? 'review' : 'empty');
        setBusy(false);
      } else if (job?.status === 'error') {
        stopScanPoll();
        setError(job.error || 'Scan failed.');
        setStage('setup');
        setBusy(false);
      }
    } catch {
      // transient poll error — keep polling.
    }
  }

  async function scan() {
    if (referenceIds.length === 0) {
      setError('Select at least one reference image before scanning.');
      return;
    }
    setBusy(true);
    setError(null);
    setStage('scanning');
    setScanJob({ status: 'queued', started_at: new Date().toISOString(), events: [] });
    setShowScanLog(true);
    const seq = openSeqRef.current;
    try {
      const res = await apiPostJson(`${basePath}/tune-scan`, { reference_image_ids: referenceIds });
      if (seq !== openSeqRef.current) return;
      stopScanPoll();
      scanPollRef.current = setInterval(() => pollScan(res.job_id, seq), 2000);
      pollScan(res.job_id, seq);
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Could not start scan');
      setStage('setup');
      setBusy(false);
    }
  }

  function updateShot(key, field, value) {
    setProposedShots((prev) => prev.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  }
  function removeShot(key) {
    setProposedShots((prev) => prev.filter((s) => s.key !== key));
  }
  function addShot() {
    setProposedShots((prev) => [...prev, { key: nextKey(), name: 'New plate', prompt: '', justification: '', quote: '' }]);
  }

  async function generateSheet() {
    const ready = proposedShots
      .map((s) => ({ name: s.name.trim(), prompt: s.prompt.trim() }))
      .filter((s) => s.name && s.prompt);
    if (!ready.length) {
      setError('Add at least one plate with a name and a prompt.');
      return;
    }
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

  const hasReferences = referenceIds.length > 0;
  const reviewReady = proposedShots.some((s) => s.name.trim() && s.prompt.trim());

  let footer;
  if (stage === 'review') {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className="primary"
          onClick={generateSheet}
          disabled={busy || !reviewReady || !hasReferences || !IMAGE_MODEL_IDS.has(imageModel)}
        >
          {busy ? 'Starting…' : `Generate ${proposedShots.length} new plate${proposedShots.length === 1 ? '' : 's'}`}
        </button>
      </>
    );
  } else if (stage === 'empty') {
    footer = <button type="button" className="primary" onClick={onClose}>Close</button>;
  } else {
    footer = (
      <>
        <button type="button" onClick={onClose} disabled={busy && stage !== 'scanning'}>Cancel</button>
        <button type="button" className="primary" onClick={scan} disabled={busy || !hasReferences}>
          {stage === 'scanning' ? 'Scanning…' : 'Scan storyboard'}
        </button>
      </>
    );
  }

  const modalSize = stage === 'review' ? 'xl' : 'wide';

  return (
    <>
      <Modal
        open={open}
        title="Tune image sheet for storyboard"
        onClose={onClose}
        dismissible={!busy}
        size={modalSize}
        footer={footer}
      >
        <div className="frame-generate-modal">
          <p className="tab-intro" style={{ marginTop: 0 }}>
            Scan this beat's storyboard against the existing plates and add only the new plates the
            shots still need. Existing plates are kept; nothing is duplicated.
          </p>

          {stage !== 'scanning' && (
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
                    These are the references used for the initial image sheet — add or remove some,
                    then scan. Use <strong>+ Add references</strong> to choose more.
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

          {stage === 'setup' && (
            <div className="image-sheet-derive-setup">
              <span className="frame-generate-help">
                Click <strong>Scan storyboard</strong> to review every shot against the current plates.
                You'll review and edit the proposed new plates before any images are generated.
              </span>
            </div>
          )}

          {stage === 'scanning' && scanJob && (
            <div className="image-sheet-progress">
              <GenerationProgress
                job={scanJob}
                noun="shot"
                showLog={showScanLog}
                onToggleLog={() => setShowScanLog((s) => !s)}
                logRef={scanLogRef}
              />
            </div>
          )}

          {stage === 'empty' && (
            <div className="frame-generate-ref-empty">
              No new plates needed — the existing image sheet already covers every storyboard shot.
            </div>
          )}

          {stage === 'review' && (
            <div className="image-sheet-review">
              <div className="frame-generate-section-header">
                <span className="field-label">New plates to generate ({proposedShots.length})</span>
                <button type="button" onClick={addShot} disabled={busy}>+ Add plate</button>
              </div>
              <div className="image-sheet-plate-list">
                {proposedShots.map((s, i) => (
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
                    {s.justification && <div className="image-sheet-plate-just">{s.justification}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(stage === 'setup' || stage === 'review') && (
            <div className="frame-generate-model-row">
              <span className="field-label">Image model</span>
              <div className="frame-generate-model-options">
                {IMAGE_MODELS.map((m) => (
                  <label key={m.id}>
                    <input
                      type="radio"
                      name="tune-image-model"
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

          {error && <div className="error-banner">{error}</div>}
        </div>
      </Modal>
      <ArtworkReferencePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onApply={(ids) => setReferenceIds(ids)}
        hostType="beat"
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
        selectedIds={referenceIds}
      />
    </>
  );
}
