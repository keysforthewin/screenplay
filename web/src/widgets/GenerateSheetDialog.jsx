import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson, imageUrl } from '../api.js';

const POLL_INTERVAL_MS = 2000;

const QUALITY_OPTIONS = ['low', 'medium', 'high', 'auto'];
const MODEL_STORAGE_KEY = 'screenplay.sheet.model';
const VALID_MODELS = new Set(['gemini', 'openai']);
const MODEL_LABEL = { gemini: 'Gemini (Nano Banana)', openai: 'OpenAI (gpt-image)' };

function readStoredModel() {
  try {
    const v = localStorage.getItem(MODEL_STORAGE_KEY);
    return VALID_MODELS.has(v) ? v : 'gemini';
  } catch {
    return 'gemini';
  }
}

// "Generate character sheet…" dialog. Opens with the prompt the server
// would build pre-filled in an editable textarea so the user can tweak it
// (e.g. inject "young version" instructions for a variant). The reference
// image grid is multi-select; the character's main image is pre-checked.
//
// Submit posts to /character/:id/character-sheet which APPENDS the result
// to the character's character_sheet_image_ids[]. Old sheets are kept.
export function GenerateSheetDialog({ open, onClose, character, onGenerated }) {
  const cid = character?._id;
  const [model, setModel] = useState(readStoredModel);
  const [quality, setQuality] = useState('auto');
  const [omitImages, setOmitImages] = useState(false);
  const [sheetName, setSheetName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptError, setPromptError] = useState(null);
  const [selectedRefIds, setSelectedRefIds] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const pollRef = useRef(null);

  const portraitImages = character?.images || [];
  const mainImageId = character?.main_image_id ? String(character.main_image_id) : null;

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Stop polling on unmount so a closed dialog doesn't keep firing requests.
  // The job continues server-side; the page's character room broadcast still
  // refreshes the sheet list when the new sheet is appended.
  useEffect(() => {
    return () => stopPolling();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {}
  }, [model]);

  // When the dialog opens, fetch the server-built default prompt and
  // reset the form. Default-select the main image as a reference. Reset
  // any in-flight job state from a previous open.
  useEffect(() => {
    if (!open || !cid) return;
    let cancelled = false;
    setPromptError(null);
    setError(null);
    setJobStatus(null);
    stopPolling();
    setPromptLoading(true);
    setSheetName('');
    setSelectedRefIds(mainImageId ? [mainImageId] : []);
    (async () => {
      try {
        const r = await apiGet(`/character/${cid}/character-sheet/preview-prompt`);
        if (!cancelled) setPrompt(r.prompt || '');
      } catch (e) {
        if (!cancelled) setPromptError(e.message || 'Failed to load prompt');
      } finally {
        if (!cancelled) setPromptLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cid]);

  function toggleRef(id) {
    setSelectedRefIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function pollJob(jobId) {
    try {
      const r = await apiGet(`/character-sheet/job/${jobId}`);
      const job = r?.job;
      if (!job) return;
      setJobStatus(job);
      if (job.status === 'done') {
        stopPolling();
        setGenerating(false);
        onGenerated?.(job.result || {});
        // Brief pause so the user sees the success message, then close.
        setTimeout(() => onClose?.(), 800);
      } else if (job.status === 'error') {
        stopPolling();
        setGenerating(false);
        setError(job.error || 'Generation failed.');
      }
    } catch {
      // Transient errors are tolerated; polling keeps trying.
    }
  }

  async function submit() {
    if (!cid) return;
    setError(null);
    setJobStatus({ status: 'queued' });
    setGenerating(true);
    try {
      const body = {
        model,
        quality,
        omit_images: omitImages,
        sheet_name: sheetName.trim() || null,
        prompt: prompt.trim() || null,
        reference_image_ids: omitImages ? [] : selectedRefIds,
      };
      const r = await apiPostJson(`/character/${cid}/character-sheet`, body);
      const jobId = r?.job_id;
      if (!jobId) {
        // Backwards-compat with synchronous response shape (shouldn't happen
        // against the new server, but harmless): treat it as a completed
        // result.
        setGenerating(false);
        onGenerated?.(r);
        onClose?.();
        return;
      }
      // Trigger one immediate poll so status updates fast, then steady state.
      pollJob(jobId);
      pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS);
    } catch (e) {
      setGenerating(false);
      setError(e.message || 'Generation failed');
    }
  }

  function statusText(job) {
    if (!job) return null;
    if (job.status === 'queued') return 'Queued…';
    if (job.status === 'generating') return 'Generating… (this can take 60–120 s)';
    if (job.status === 'done') return `Done — sheet "${job.result?.sheet_name || 'sheet'}" added.`;
    if (job.status === 'error') return `Error: ${job.error || 'Generation failed.'}`;
    return null;
  }

  const existingCount = (character?.character_sheet_image_ids || []).length;
  const namePlaceholder = `Sheet ${existingCount + 1}`;

  return (
    <Modal
      open={open}
      title="Generate character sheet"
      onClose={onClose}
      dismissible
      footer={
        <>
          <button type="button" onClick={onClose}>
            {generating ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={generating || promptLoading || !prompt.trim()}
          >
            {generating
              ? jobStatus?.status === 'queued'
                ? 'Queued…'
                : 'Generating…'
              : 'Generate'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <div className="error-banner">{error}</div>}
        {promptError && <div className="error-banner">{promptError}</div>}
        {jobStatus && jobStatus.status !== 'error' && (
          <div
            style={{
              background: 'var(--accent-bg, rgba(255,255,255,0.04))',
              padding: '8px 12px',
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            {statusText(jobStatus)}
            {jobStatus.status === 'generating' && (
              <span style={{ marginLeft: 6, color: 'var(--fg-muted)' }}>
                You can close this dialog — the job continues in the background and the sheet will
                appear in the list when it's ready.
              </span>
            )}
          </div>
        )}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">Sheet name</span>
          <input
            type="text"
            value={sheetName}
            placeholder={namePlaceholder}
            onChange={(e) => setSheetName(e.target.value)}
            disabled={generating}
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Shown in the sheet list and the storyboard sheet picker.
          </span>
        </label>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <span className="quality-group">
            Model:
            <select
              value={model}
              disabled={generating}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="gemini">{MODEL_LABEL.gemini}</option>
              <option value="openai">{MODEL_LABEL.openai}</option>
            </select>
          </span>
          {model === 'openai' && (
            <span className="quality-group">
              Quality:
              {QUALITY_OPTIONS.map((q) => (
                <label key={q}>
                  <input
                    type="radio"
                    name="gen-quality"
                    value={q}
                    checked={quality === q}
                    disabled={generating}
                    onChange={() => setQuality(q)}
                  />
                  {q}
                </label>
              ))}
            </span>
          )}
          <label>
            <input
              type="checkbox"
              checked={omitImages}
              disabled={generating}
              onChange={(e) => setOmitImages(e.target.checked)}
            />
            Omit reference images (text-only)
          </label>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">Prompt</span>
          {promptLoading ? (
            <div style={{ color: 'var(--fg-muted)' }}>Loading prompt…</div>
          ) : (
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={generating}
              rows={14}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          )}
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Edit before submitting (e.g. inject "make him 12 years old" for a young variant).
          </span>
        </label>

        <div>
          <span className="field-label">Reference images ({selectedRefIds.length} selected)</span>
          {portraitImages.length === 0 ? (
            <div style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 6 }}>
              No portrait images attached. Upload some on the Details tab to use as references, or
              check "Omit reference images" to generate from text only.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 8,
                marginTop: 6,
                opacity: omitImages ? 0.5 : 1,
                pointerEvents: omitImages ? 'none' : 'auto',
              }}
            >
              {portraitImages.map((img) => {
                const id = img._id?.toString?.() || String(img._id);
                const checked = selectedRefIds.includes(id);
                const isMain = id === mainImageId;
                return (
                  <label
                    key={id}
                    className={`gallery-thumb${checked ? ' is-main' : ''}`}
                    style={{
                      flex: '0 0 auto',
                      width: '100%',
                      cursor: 'pointer',
                      position: 'relative',
                    }}
                  >
                    <img
                      src={imageUrl(id)}
                      alt={img.caption || img.filename || 'portrait'}
                      style={{ width: '100%', height: 100, objectFit: 'cover' }}
                    />
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={generating || omitImages}
                      onChange={() => toggleRef(id)}
                      style={{ position: 'absolute', top: 6, left: 6 }}
                    />
                    {isMain && (
                      <span
                        style={{
                          position: 'absolute',
                          bottom: 4,
                          right: 4,
                          fontSize: 10,
                          color: 'var(--accent)',
                          background: 'rgba(0,0,0,0.5)',
                          padding: '1px 4px',
                          borderRadius: 3,
                        }}
                      >
                        ★ main
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
