import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import {
  apiGet,
  apiPostJson,
  apiSseUrl,
  attachmentUrl,
  imageUrl,
  thumbUrl,
} from '../api.js';
import { computeVideoCost, formatUsd as formatUsdAmount } from '../videoCost.js';
import { VideoProgressBar } from './VideoProgressBar.jsx';
import { useCollabRoom } from '../editor/CollabSurface.jsx';
import { readFragmentMarkdown } from '../editor/fragmentRead.js';

// Capability facets shown in the picker. Order is the column order in the
// matrix and the checkbox order below it.
const FACETS = [
  { key: 'lip_sync', short: 'lip', label: 'Lip sync (avatar)' },
  { key: 'start_frame', short: 'start', label: 'Start frame' },
  { key: 'end_frame', short: 'end', label: 'End frame' },
  { key: 'character_sheet', short: 'char', label: 'Character sheet' },
  { key: 'reference_images', short: 'ref', label: 'Reference images' },
];

const EMPTY_FACETS = Object.freeze({ lip_sync: false, start_frame: false, end_frame: false, character_sheet: false, reference_images: false });

// localStorage key for the most recently generated-with video model. We persist
// the endpoint_id (not model_id) because the picker selects rows by endpoint —
// a single registered model can have multiple endpoint variants in the catalog.
const LAST_MODEL_KEY = 'screenplay.video.last_model_endpoint';

function readLastEndpoint() {
  try { return localStorage.getItem(LAST_MODEL_KEY) || null; } catch { return null; }
}
function writeLastEndpoint(endpointId) {
  try { if (endpointId) localStorage.setItem(LAST_MODEL_KEY, endpointId); } catch {}
}

// "Generate video…" dialog opened from the storyboard scene's AudioSlot.
// Lets the user filter the fal.ai i2v catalog (data/fal-models.json) by the
// input modalities the scene provides, pick a model, then POSTs the request
// and opens an EventSource on the matching job stream so the progress bar
// updates as fal's queue position changes. The fal task continues server-
// side even if the user closes the dialog — when the storyboard's
// video_file_id lands the inline player will appear automatically via the
// room's fields_updated ping.
export function GenerateVideoDialog({ open, onClose, storyboardId, sb, onRefresh }) {
  const { ydoc } = useCollabRoom();
  const [registry, setRegistry] = useState(null); // { default_model_id, configured, catalog_generated_at, catalog_error, models: [...] }
  const [registryError, setRegistryError] = useState(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState(null); // endpoint_id of the chosen catalog row
  const [activeFacets, setActiveFacets] = useState({ ...EMPTY_FACETS });
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(null);
  const [resolution, setResolution] = useState(null);
  const [fps, setFps] = useState(24);
  const [generateAudio, setGenerateAudio] = useState(false);
  const [includeDirectorNotes, setIncludeDirectorNotes] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  // Two-step submit: clicking "Preview payload" populates `preview` with the
  // exact payload the orchestrator would ship to fal. Only after the user
  // clicks Approve do we actually POST /video/generate.
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // endpoint_id of the most-recently-used model from localStorage. Used both
  // to pre-select on open and to render a "(last used)" badge in the list.
  // Captured at open-time so the badge doesn't migrate mid-dialog after a
  // successful submit — it migrates on the next open.
  const [lastUsedEndpoint, setLastUsedEndpoint] = useState(null);
  const esRef = useRef(null);

  function closeStream() {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }

  // Fetch the model registry on open. Refreshable via the footer link after
  // the user runs `npm run refresh:fal-models` from the terminal.
  function loadRegistry() {
    let cancelled = false;
    apiGet('/video-models')
      .then((r) => {
        if (cancelled) return;
        setRegistry(r);
        setRegistryError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setRegistryError(e.message || 'Failed to load model list.');
      });
    return () => {
      cancelled = true;
    };
  }
  useEffect(() => {
    if (!open) return;
    if (registry) return;
    return loadRegistry();
  }, [open, registry]);

  const chosenModel = useMemo(() => {
    if (!registry) return null;
    if (!selectedEndpoint) return null;
    return registry.models.find((m) => m.endpoint_id === selectedEndpoint) || null;
  }, [registry, selectedEndpoint]);

  // Reset form fields whenever the dialog opens or the storyboard changes.
  useEffect(() => {
    if (!open) {
      closeStream();
      return;
    }
    setError(null);
    setJob(null);
    setGenerating(false);
    setPreview(null);
    setPreviewLoading(false);
    setGenerateAudio(false);
    setIncludeDirectorNotes(true);
    setActiveFacets({ ...EMPTY_FACETS });
    // Prefer the live y-doc fragment text over the (possibly stale) sb prop:
    // sb.text_prompt comes from the last REST fetch, which lags any in-flight
    // edits in the CollabField by ~2s of Hocuspocus debounce. The y-doc has
    // every keystroke applied locally, so reading from it here means clicking
    // "Generate video" right after editing the prompt picks up the new text
    // without a page reload.
    let initialPrompt = '';
    if (ydoc && storyboardId) {
      try {
        initialPrompt = readFragmentMarkdown(ydoc, `item:${storyboardId}:text_prompt`).trim();
      } catch {
        // Y-doc not yet hydrated or fragment never written — fall through.
      }
    }
    if (!initialPrompt) {
      initialPrompt = typeof sb?.text_prompt === 'string' ? sb.text_prompt : '';
    }
    setPrompt(initialPrompt);
    const storedEndpoint = readLastEndpoint();
    setLastUsedEndpoint(storedEndpoint);
    if (registry) {
      const storedRow = storedEndpoint
        ? registry.models.find((m) => m.endpoint_id === storedEndpoint && m.is_registered) || null
        : null;
      const defaultRow = storedRow
        || registry.models.find((m) => m.is_registered && m.id === registry.default_model_id)
        || registry.models.find((m) => m.is_registered)
        || null;
      setSelectedEndpoint(defaultRow?.endpoint_id || null);
    }
  }, [open, sb?._id, registry, ydoc, storyboardId]);

  // When the chosen model changes, snap duration / resolution / fps to
  // that model's defaults (or to the storyboard's duration_seconds,
  // clamped to allowed values). Duration falls back to a free-form 5s
  // when the model doesn't publish a durations enum but still bills
  // by duration (per-second / per-megapixel).
  useEffect(() => {
    if (!chosenModel) return;
    const allowed = (chosenModel.durations || []).map(parseDurationNumber).filter(Number.isFinite);
    const sbDur = Number(sb?.duration_seconds);
    if (allowed.length) {
      let candidate = Number.isFinite(sbDur) && sbDur > 0 ? sbDur : parseDurationNumber(chosenModel.default_duration);
      if (!Number.isFinite(candidate)) candidate = allowed[0];
      const closest = allowed.reduce(
        (best, n) => (Math.abs(n - candidate) < Math.abs(best - candidate) ? n : best),
        allowed[0],
      );
      setDuration(closest);
    } else if (modelNeedsDuration(chosenModel)) {
      const free = Number.isFinite(sbDur) && sbDur > 0 ? Math.min(15, Math.round(sbDur)) : 5;
      setDuration(free);
    } else {
      setDuration(null);
    }
    setResolution(pickDefaultResolution(chosenModel));
    setFps(pickDefaultFps(chosenModel));
  }, [chosenModel, sb?.duration_seconds]);

  useEffect(() => () => closeStream(), []);

  // Pre-flight: which inputs does the chosen model need that aren't on this
  // storyboard yet? Server validates the same thing on submit; this lets us
  // disable the button and show a tooltip without a round-trip.
  const missing = useMemo(() => {
    if (!chosenModel) return [];
    const out = [];
    const need = chosenModel.inputs || {};
    if (need.startFrame === 'required' && !sb?.start_frame_id) out.push('start frame');
    if (need.endFrame === 'required' && !sb?.end_frame_id) out.push('end frame');
    if (need.characterSheet === 'required' && !sb?.character_sheet_image_id) out.push('character sheet');
    if (need.audio === 'required' && !sb?.audio_file_id) out.push('audio');
    return out;
  }, [chosenModel, sb]);

  // Models that pass the current facet filter (AND across checked facets).
  const visibleModels = useMemo(() => {
    if (!registry?.models) return [];
    const checked = FACETS.filter((f) => activeFacets[f.key]);
    return registry.models.filter((m) =>
      checked.every((f) => m.capabilities?.[f.key] === true),
    );
  }, [registry, activeFacets]);

  // Live narrowed count per facet ("how many models would be visible if I
  // toggle THIS facet, holding the others as-is?"). Renders next to each
  // checkbox so the user can see where adding a constraint leads.
  const facetCounts = useMemo(() => {
    if (!registry?.models?.length) return {};
    const out = {};
    for (const f of FACETS) {
      const candidate = { ...activeFacets, [f.key]: true };
      const checked = FACETS.filter((g) => candidate[g.key]);
      out[f.key] = registry.models.filter((m) =>
        checked.every((g) => m.capabilities?.[g.key] === true),
      ).length;
    }
    return out;
  }, [registry, activeFacets]);

  function toggleFacet(key) {
    setActiveFacets((s) => ({ ...s, [key]: !s[key] }));
  }

  // Build the request body the same way for /preview and /generate so both
  // endpoints see identical inputs — otherwise the user's "approve" doesn't
  // actually approve what we ship.
  function buildRequestBody() {
    const body = {
      model_id: chosenModel.id,
      prompt: prompt.trim() || null,
    };
    if (duration != null) body.duration_seconds = duration;
    if (chosenModel.supports_generate_audio) body.generate_audio = generateAudio;
    body.include_director_notes = includeDirectorNotes;
    if (shouldShowResolution(chosenModel) && resolution) {
      body.resolution = resolution;
    }
    if (shouldShowFps(chosenModel) && Number.isFinite(fps) && fps > 0) {
      body.fps = fps;
    }
    return body;
  }

  async function loadPreview() {
    setError(null);
    if (!chosenModel?.is_registered || !chosenModel?.id) {
      setError('Selected model is preview-only (not yet wired up). Pick a Ready model.');
      return;
    }
    setPreviewLoading(true);
    try {
      const body = buildRequestBody();
      const r = await apiPostJson(`/storyboard/${storyboardId}/video/preview`, body);
      setPreview(r);
    } catch (e) {
      let msg = e.message || 'Preview failed.';
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error) msg = parsed.error;
      } catch {}
      setError(msg);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function submit() {
    setError(null);
    setJob({ status: 'queued', step: 'Queued', started_at: new Date().toISOString() });
    setGenerating(true);
    try {
      if (!chosenModel?.is_registered || !chosenModel?.id) {
        setGenerating(false);
        setError('Selected model is preview-only (not yet wired up). Pick a Ready model.');
        return;
      }
      const body = buildRequestBody();
      const r = await apiPostJson(`/storyboard/${storyboardId}/video/generate`, body);
      const jobId = r?.job_id;
      if (!jobId) {
        setGenerating(false);
        setError('Server did not return a job id.');
        return;
      }
      writeLastEndpoint(chosenModel.endpoint_id);
      const es = new EventSource(
        apiSseUrl(`/storyboard/${storyboardId}/video-job/${jobId}/events`),
      );
      esRef.current = es;
      es.addEventListener('snapshot', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('update', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('done', (ev) => {
        setJob(safeParse(ev.data));
        setGenerating(false);
        closeStream();
        onRefresh?.();
        setTimeout(() => onClose?.(), 700);
      });
      es.addEventListener('error', (ev) => {
        // Two cases: SSE-level disconnect (no data) or server-emitted
        // 'error' event with a job payload. Disambiguate by checking data.
        const data = ev?.data ? safeParse(ev.data) : null;
        if (data) {
          setJob(data);
          setError(data.error || 'Generation failed.');
          setGenerating(false);
          closeStream();
        } else if (es.readyState === EventSource.CLOSED) {
          setGenerating(false);
          setError('Connection lost.');
        }
      });
    } catch (e) {
      setGenerating(false);
      setError(e.message || 'Generation failed.');
    }
  }

  const ready =
    !generating &&
    !previewLoading &&
    chosenModel?.is_registered &&
    missing.length === 0;
  const submitTooltip = !chosenModel
    ? 'Pick a model from the list.'
    : !chosenModel.is_registered
    ? 'Preview model — not yet wired up. Add to src/fal/videoModels.js to enable.'
    : missing.length
    ? `Need: ${missing.join(', ')}`
    : '';
  const showPreviewPanel = Boolean(preview) && !generating && !job?.video_file_id;

  return (
    <Modal
      open={open}
      title="Generate video"
      onClose={onClose}
      dismissible
      size="xl"
      footer={
        <button type="button" onClick={onClose}>
          {generating ? 'Close' : 'Cancel'}
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && <div className="error-banner">{error}</div>}
        {registryError && <div className="error-banner">{registryError}</div>}

        {registry && !registry.configured ? (
          <div className="error-banner">
            fal.ai is not configured on the server. Set <code>FAL_KEY</code> in your env
            to enable video generation.
          </div>
        ) : null}

        <ModelPicker
          registry={registry}
          generating={generating}
          activeFacets={activeFacets}
          facetCounts={facetCounts}
          visibleModels={visibleModels}
          chosenModel={chosenModel}
          lastUsedEndpoint={lastUsedEndpoint}
          onToggleFacet={toggleFacet}
          onClearFacets={() => setActiveFacets({ ...EMPTY_FACETS })}
          onModelClick={(m) => setSelectedEndpoint(m.endpoint_id)}
          onRefreshCatalog={() => {
            setRegistry(null);
            loadRegistry();
          }}
        />

        {missing.length ? (
          <div className="warn-banner small" style={{ fontSize: 13, color: '#ffb86b' }}>
            This model needs: <b>{missing.join(', ')}</b>. Add them to the scene first.
          </div>
        ) : null}

        {generating || job ? <VideoProgressBar job={job} /> : null}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="field-label">Prompt (override)</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={generating}
            rows={6}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            placeholder="Leave blank to use the scene's text_prompt"
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Markdown is stripped server-side. Long prompts are truncated at 2000 chars.
          </span>
        </label>

        <div className="video-action-row">
          {chosenModel?.durations?.length ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="field-label">Duration</span>
              <select
                value={duration ?? ''}
                disabled={generating}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {chosenModel.durations.map((d) => {
                  const n = parseDurationNumber(d);
                  return (
                    <option key={d} value={n}>
                      {n}s
                    </option>
                  );
                })}
              </select>
            </label>
          ) : chosenModel && modelNeedsDuration(chosenModel) ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="field-label">Duration</span>
              <input
                type="number"
                min={1}
                max={15}
                step={1}
                value={duration ?? ''}
                disabled={generating}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1 && n <= 15) setDuration(n);
                  else if (e.target.value === '') setDuration(null);
                }}
                style={{ width: 70 }}
              />
            </label>
          ) : null}

          {chosenModel && shouldShowResolution(chosenModel) ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="field-label">Resolution</span>
              <select
                value={resolution ?? ''}
                disabled={generating}
                onChange={(e) => setResolution(e.target.value || null)}
              >
                {resolutionOptions(chosenModel).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {chosenModel && shouldShowFps(chosenModel) ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="field-label">FPS</span>
              <select
                value={fps}
                disabled={generating}
                onChange={(e) => setFps(Number(e.target.value))}
              >
                {FPS_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {chosenModel?.supports_generate_audio ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={generateAudio}
                disabled={generating}
                onChange={(e) => setGenerateAudio(e.target.checked)}
              />
              <span className="field-label" style={{ margin: 0 }}>
                Generate audio from prompt
              </span>
            </label>
          ) : null}

          <label
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            title="Append the project-wide director's notes to the prompt sent to fal."
          >
            <input
              type="checkbox"
              checked={includeDirectorNotes}
              disabled={generating}
              onChange={(e) => setIncludeDirectorNotes(e.target.checked)}
            />
            <span className="field-label" style={{ margin: 0 }}>
              Include director's notes
            </span>
          </label>

          {chosenModel ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="field-label">Cost estimate</span>
              <CostEstimate
                model={chosenModel}
                duration={duration}
                generateAudio={generateAudio}
                resolution={resolution}
                fps={fps}
                audioDuration={sb?.audio_duration_seconds || null}
              />
            </div>
          ) : null}

          <div className="video-action-spacer" />

          <button
            type="button"
            className="primary"
            disabled={!ready}
            title={submitTooltip}
            onClick={loadPreview}
          >
            {previewLoading
              ? 'Building preview…'
              : generating
              ? 'Generating…'
              : 'Preview payload…'}
          </button>
        </div>

        {showPreviewPanel ? (
          <PayloadPreviewPanel
            preview={preview}
            generating={generating}
            onCancel={() => setPreview(null)}
            onApprove={() => {
              setPreview(null);
              submit();
            }}
          />
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// PayloadPreviewPanel: shows the exact payload that would be POSTed to fal.
// Renders the resolved prompt, every input file (with thumbnail) the
// orchestrator would upload, and the JSON object fal would receive (with
// screenplay-preview:// sentinel URLs). User must click Approve before the
// real /video/generate request goes out.

const PREVIEW_IMAGE_RE = /^screenplay-preview:\/\/image\/([a-f0-9]{24})$/i;
const PREVIEW_ATTACHMENT_RE = /^screenplay-preview:\/\/attachment\/([a-f0-9]{24})$/i;

function previewSentinelToLocal(sentinel) {
  if (typeof sentinel !== 'string') return null;
  const im = PREVIEW_IMAGE_RE.exec(sentinel);
  if (im) return { kind: 'image', id: im[1] };
  const at = PREVIEW_ATTACHMENT_RE.exec(sentinel);
  if (at) return { kind: 'attachment', id: at[1] };
  return null;
}

function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function PayloadPreviewPanel({ preview, generating, onCancel, onApprove }) {
  const inputs = Array.isArray(preview?.inputs) ? preview.inputs : [];
  const warnings = Array.isArray(preview?.warnings) ? preview.warnings : [];
  const imageInputs = inputs.filter((i) => i.kind === 'image');
  const audioInputs = inputs.filter((i) => i.kind === 'attachment');
  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        border: '2px solid var(--accent)',
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          Confirm fal.ai payload
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'monospace' }}>
          {preview?.model?.fal_model}
        </div>
      </div>

      {warnings.length ? (
        <div className="warn-banner small" style={{ fontSize: 12, color: '#ffb86b' }}>
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      ) : null}

      <div>
        <div className="field-label" style={{ marginBottom: 4 }}>
          Resolved prompt ({(preview?.prompt || '').length} chars)
        </div>
        <pre
          style={{
            margin: 0,
            padding: 8,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 240,
            overflow: 'auto',
          }}
        >
          {preview?.prompt || '(empty)'}
        </pre>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
        <div>
          <span style={{ color: 'var(--fg-muted)' }}>Model:</span>{' '}
          <b>{preview?.model?.label}</b>
          {preview?.model?.lab ? (
            <span style={{ color: 'var(--fg-muted)' }}>{` · ${preview.model.lab}`}</span>
          ) : null}
        </div>
        <div>
          <span style={{ color: 'var(--fg-muted)' }}>Duration:</span>{' '}
          <b>{preview?.duration_seconds ?? '—'}s</b>
        </div>
        <div>
          <span style={{ color: 'var(--fg-muted)' }}>Generate audio:</span>{' '}
          <b>{preview?.generate_audio ? 'yes' : 'no'}</b>
        </div>
        {preview?.estimated_cost_usd != null ? (
          <div title={preview?.pricing_basis || ''}>
            <span style={{ color: 'var(--fg-muted)' }}>Estimated cost:</span>{' '}
            <b>
              {preview.pricing_exact === false ? '≈ ' : ''}
              {formatUsdAmount(preview.estimated_cost_usd) || '—'}
            </b>
          </div>
        ) : null}
        <div>
          <span style={{ color: 'var(--fg-muted)' }}>Inputs uploaded to fal:</span>{' '}
          <b>{inputs.length}</b>
        </div>
      </div>

      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>
          Image inputs ({imageInputs.length})
        </div>
        {imageInputs.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            No images will be uploaded to fal.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {imageInputs.map((i, idx) => (
              <PreviewAssetCard key={`${i.slot}-${i.image_id}-${idx}`} input={i} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>
          Audio inputs ({audioInputs.length})
        </div>
        {audioInputs.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            No audio will be uploaded to fal.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {audioInputs.map((i, idx) => (
              <PreviewAssetCard key={`${i.slot}-${i.attachment_id}-${idx}`} input={i} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="field-label" style={{ marginBottom: 4 }}>
          Full payload (sentinel URLs in place of fal.media URLs)
        </div>
        <pre
          style={{
            margin: 0,
            padding: 8,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 11,
            fontFamily: 'monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflow: 'auto',
          }}
        >
          {JSON.stringify(preview?.payload ?? {}, null, 2)}
        </pre>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} disabled={generating}>
          Back to edit
        </button>
        <button
          type="button"
          className="primary"
          onClick={onApprove}
          disabled={generating}
          title="Send this exact payload to fal.ai. Inputs will be uploaded to fal storage immediately before submission."
        >
          Approve and send to fal.ai
        </button>
      </div>
    </div>
  );
}

function PreviewAssetCard({ input }) {
  const local = previewSentinelToLocal(input.sentinel);
  const id = local?.id || input.image_id || input.attachment_id || null;
  const isImage = input.kind === 'image';
  const sizeLabel = formatBytes(input.size);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg)',
        minWidth: 140,
        maxWidth: 200,
      }}
    >
      {isImage && id ? (
        <a href={imageUrl(id)} target="_blank" rel="noreferrer">
          <img
            src={thumbUrl(id)}
            alt={input.slot}
            style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 3 }}
          />
        </a>
      ) : input.kind === 'attachment' && id ? (
        <a
          href={attachmentUrl(id)}
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: 'var(--accent)' }}
        >
          ▶ open audio
        </a>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>(missing)</div>
      )}
      <div style={{ fontSize: 11, fontWeight: 600 }}>{input.slot}</div>
      <div style={{ fontSize: 10, color: 'var(--fg-muted)', wordBreak: 'break-all' }}>
        {input.filename || '(no filename)'}
      </div>
      <div style={{ fontSize: 10, color: 'var(--fg-muted)' }}>
        {input.content_type || '?'}{sizeLabel ? ` · ${sizeLabel}` : ''}
      </div>
      <div style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'monospace' }}>
        {id || '—'}
      </div>
      {input.missing ? (
        <div style={{ fontSize: 10, color: '#ff6b6b' }}>⚠ missing from storage</div>
      ) : null}
    </div>
  );
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ModelPicker: 5 facet checkboxes + filtered model list, full width.
// Stateless — the parent dialog owns selection / facets / registry state.

function ModelPicker({
  registry,
  generating,
  activeFacets,
  facetCounts,
  visibleModels,
  chosenModel,
  lastUsedEndpoint,
  onToggleFacet,
  onClearFacets,
  onModelClick,
  onRefreshCatalog,
}) {
  // Sort, in priority order:
  //   1. Ready (is_registered=true) before Preview — clean visual split.
  //   2. Within each group: added_at desc (newest first, nulls last).
  //   3. Within-group fallback when no entries have dates: version-number
  //      heuristic (Wan 2.7 > Wan 2.6).
  //   4. price asc (nulls last).
  //   5. display_name asc.
  const anyDates = useMemo(
    () => visibleModels.some((m) => m.added_at),
    [visibleModels],
  );
  const sortedModels = useMemo(() => {
    const arr = [...visibleModels];
    arr.sort((a, b) => {
      if (a.is_registered !== b.is_registered) return a.is_registered ? -1 : 1;
      if (anyDates) {
        const ad = a.added_at ? Date.parse(a.added_at) : NaN;
        const bd = b.added_at ? Date.parse(b.added_at) : NaN;
        const aHas = Number.isFinite(ad);
        const bHas = Number.isFinite(bd);
        if (aHas !== bHas) return aHas ? -1 : 1;
        if (aHas && bHas && ad !== bd) return bd - ad;
      } else {
        const av = versionScore(a);
        const bv = versionScore(b);
        if (av !== bv) return bv - av;
      }
      const ap = a.price_min_usd;
      const bp = b.price_min_usd;
      if (ap != null || bp != null) {
        if (ap == null) return 1;
        if (bp == null) return -1;
        if (ap !== bp) return ap - bp;
      }
      return (a.display_name || '').localeCompare(b.display_name || '');
    });
    return arr;
  }, [visibleModels, anyDates]);

  if (!registry) {
    return (
      <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Loading models…</div>
    );
  }

  const total = registry.models?.length || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span className="field-label">Model</span>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {registry.catalog_generated_at
            ? `Catalog: ${new Date(registry.catalog_generated_at).toLocaleDateString()} · `
            : ''}
          <button
            type="button"
            onClick={onRefreshCatalog}
            disabled={generating}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--accent)',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
              textDecoration: 'underline',
            }}
            title="Re-fetch /api/video-models. Run `npm run refresh:fal-models` from the terminal first."
          >
            refresh
          </button>
        </span>
      </div>

      {registry.catalog_error ? (
        <div className="warn-banner small" style={{ fontSize: 12, color: '#ffb86b' }}>
          {registry.catalog_error}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {FACETS.map((f) => (
          <label
            key={f.key}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderRadius: 4,
              background: activeFacets[f.key] ? 'rgba(122, 166, 255, 0.15)' : 'transparent',
              border: `1px solid ${activeFacets[f.key] ? 'var(--accent)' : 'var(--border)'}`,
              fontSize: 12,
              cursor: generating ? 'default' : 'pointer',
              opacity: generating ? 0.6 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={!!activeFacets[f.key]}
              onChange={() => onToggleFacet(f.key)}
              disabled={generating}
            />
            <span>{f.label}</span>
            <span style={{ color: 'var(--fg-muted)' }}>({facetCounts[f.key] ?? 0})</span>
          </label>
        ))}
        {Object.values(activeFacets).some(Boolean) ? (
          <button
            type="button"
            onClick={onClearFacets}
            disabled={generating}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              fontSize: 12,
              textDecoration: 'underline',
              padding: '4px 8px',
            }}
          >
            clear
          </button>
        ) : null}
      </div>

      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 4,
          maxHeight: 360,
          overflow: 'auto',
          background: 'var(--bg)',
        }}
      >
        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--fg-muted)', position: 'sticky', top: 0, background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
          {sortedModels.length} of {total} model{total === 1 ? '' : 's'}
        </div>
        {sortedModels.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--fg-muted)', fontSize: 13 }}>
            No models match these facets. Clear some to widen the search.
          </div>
        ) : null}
        {sortedModels.map((m) => (
          <ModelRow
            key={m.endpoint_id}
            model={m}
            selected={chosenModel?.endpoint_id === m.endpoint_id}
            lastUsed={lastUsedEndpoint && m.endpoint_id === lastUsedEndpoint}
            disabled={generating}
            onClick={() => onModelClick(m)}
          />
        ))}
      </div>
    </div>
  );
}

function ModelRow({ model, selected, lastUsed, disabled, onClick }) {
  const ready = !!model.is_registered;
  const priceLabel = model.price_min_usd != null ? `from $${formatUsdMinimum(model.price_min_usd)}` : null;
  const maxLabel = typeof model.max_seconds === 'number' ? `max ${model.max_seconds}s` : null;
  const resBadges = (model.resolutions || []).slice(0, 4);
  const addedLabel = formatAddedAt(model.added_at);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        padding: '8px 10px',
        background: selected ? 'rgba(122, 166, 255, 0.10)' : 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        color: 'var(--fg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{model.display_name || model.label}</span>
        {lastUsed ? <span className="model-last-used">last used</span> : null}
        <span
          style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            background: ready ? 'rgba(106, 207, 126, 0.15)' : 'rgba(138, 143, 163, 0.15)',
            color: ready ? 'var(--ok)' : 'var(--fg-muted)',
            border: `1px solid ${ready ? 'var(--ok)' : 'var(--border)'}`,
          }}
        >
          {ready ? 'Ready' : 'Preview'}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 3, fontSize: 11, color: 'var(--fg-muted)' }}>
        {model.model_lab ? <span>{model.model_lab}</span> : null}
        {resBadges.length ? <span>{resBadges.join(' · ')}</span> : null}
        {maxLabel ? <span>{maxLabel}</span> : null}
        {priceLabel ? (
          <span title={model.price_text || ''}>{priceLabel}</span>
        ) : model.price_text ? (
          <span title={model.price_text}>— price</span>
        ) : null}
        {addedLabel ? <span title={model.added_at}>{addedLabel}</span> : null}
      </div>
      {selected && model.description ? (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'pre-wrap' }}>
          {model.description}
        </div>
      ) : null}
      {selected ? (
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'monospace' }}>
          {model.endpoint_id}
        </div>
      ) : null}
    </button>
  );
}

// Fallback resolution list when the catalog doesn't publish a per-model
// `resolutions` array. Includes the same set the pricing tier table
// supports.
const RESOLUTION_FALLBACKS = ['480p', '720p', '1080p'];
const FPS_OPTIONS = [16, 24, 30];

function modelNeedsDuration(model) {
  const k = model?.pricing?.kind;
  if (!k) return false;
  return k === 'per_second' || k === 'per_second_tiered' || k === 'per_megapixel';
}

function shouldShowResolution(model) {
  if (!model) return false;
  const k = model.pricing?.kind;
  if (k === 'per_second_tiered' || k === 'per_megapixel') return true;
  if (Array.isArray(model.resolutions) && model.resolutions.length) return true;
  return modelDeclares(model, 'resolution') || modelDeclares(model, 'video_size');
}

function shouldShowFps(model) {
  if (!model) return false;
  if (model.pricing?.kind === 'per_megapixel') return true;
  return modelDeclares(model, 'fps');
}

function modelDeclares(model, paramName) {
  return (
    (model.inputs_required || []).includes(paramName) ||
    (model.inputs_optional || []).includes(paramName)
  );
}

function resolutionOptions(model) {
  const declared = Array.isArray(model?.resolutions) ? model.resolutions : [];
  const filtered = declared.filter((r) => r && r !== 'auto');
  if (filtered.length) return filtered;
  return RESOLUTION_FALLBACKS;
}

function pickDefaultResolution(model) {
  if (!model) return null;
  if (model.pricing?.default_resolution) {
    return model.pricing.default_resolution;
  }
  const options = resolutionOptions(model);
  if (options.includes('720p')) return '720p';
  return options[0] || null;
}

function pickDefaultFps(model) {
  return model?.pricing?.default_fps || 24;
}

// Catalog `durations_enum` entries arrive as '4s' / '6s' / '8s' on some
// models and bare '4' / '6' / '8' on others. Strip a trailing 's' before
// parsing so option values stay as plain integers (not NaN) either way.
function parseDurationNumber(d) {
  if (d == null) return NaN;
  return Number(String(d).replace(/s$/i, ''));
}

function formatUsdMinimum(n) {
  if (n == null) return '—';
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function formatAddedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `added ${d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })}`;
}

// Fallback sort key when the catalog has no per-model dates. Pulls the first
// number out of `model_family` (e.g. "Wan 2.7" -> 2.7, "Vidu Q3" -> 3); the
// sort uses this descending so newer versions float to the top within a lab.
function versionScore(model) {
  const family = model.model_family || '';
  const match = String(family).match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

// Cost estimate shown next to the duration picker (or stand-alone for
// models with no user-configurable duration). Reads the structured
// `model.pricing` returned by /api/video-models — see
// web/src/videoCost.js and src/fal/videoPricing.js. Falls through to
// "≈ varies" only when pricing isn't structured (rare; legacy catalog
// rows with unparseable price_text).
function CostEstimate({ model, duration, generateAudio, resolution, fps, audioDuration }) {
  if (!model) return null;
  const tooltipBase =
    model.price_text || model.pricing?.note ||
    'fal does not publish a structured price for this model.';
  if (model.pricing?.kind === 'unknown' || (!model.pricing && !model.price_text)) {
    return (
      <span
        title={tooltipBase}
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          fontFamily: 'monospace',
          cursor: 'help',
        }}
      >
        rate not published by fal
      </span>
    );
  }
  const est = computeVideoCost(model, {
    duration,
    generateAudio,
    audioDuration,
    resolution,
    fps,
  });
  if (!est) {
    return (
      <span
        title={tooltipBase}
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          fontFamily: 'monospace',
          cursor: 'help',
        }}
      >
        ≈ varies (see model price)
      </span>
    );
  }
  if (est.totalUsd == null) {
    const missing = Array.isArray(est.missing) && est.missing.length
      ? `pick ${est.missing.join(' + ')} to see cost`
      : est.basis;
    return (
      <span
        title={`${est.basis}\n\nfal price text:\n${tooltipBase}`}
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          fontFamily: 'monospace',
          cursor: 'help',
        }}
      >
        {missing.startsWith('pick') ? missing : `≈ ${missing}`}
      </span>
    );
  }
  const totalLabel = formatUsdAmount(est.totalUsd);
  const rateLabel = est.perSecondUsd != null ? formatUsdAmount(est.perSecondUsd) : null;
  const exactPrefix = est.exact ? '' : '≈ ';
  return (
    <span
      title={`${est.basis}\n\nfal price text:\n${tooltipBase}`}
      style={{
        fontSize: 12,
        color: 'var(--fg)',
        fontFamily: 'monospace',
        cursor: 'help',
      }}
    >
      {exactPrefix}{totalLabel}{' '}
      {rateLabel ? (
        <span style={{ color: 'var(--fg-muted)' }}>{`(${rateLabel}/s)`}</span>
      ) : null}
    </span>
  );
}
