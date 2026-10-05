import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson } from '../api.js';
import { ModelGroup, COMFY_DISABLED_MESSAGE } from './comfyControls.jsx';
import { PARAM_ORDER, ParamField, defaultParamsFor } from './ComfyVideoDialog.jsx';
import {
  EMPTY_FACETS,
  FACETS,
  FPS_OPTIONS,
  ModelPicker,
  modelSearchText,
  pickDefaultFps,
  pickDefaultResolution,
  readLastEndpoint,
  resolutionOptions,
  shouldShowFps,
  shouldShowResolution,
  writeLastEndpoint,
} from './GenerateVideoDialog.jsx';

// "Generate all videos" for one beat: pick ComfyUI or fal.ai and a model,
// queue every cut that has both frames, and close. The batch runs on the
// server (POST /cuts/videos/generate-all); each cut renders with its own
// video prompt, frames and length, so there is no prompt or length here.

function parseError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.errors?.length ? `${parsed.error}: ${parsed.errors.join('; ')}` : parsed.error;
  } catch {}
  return msg;
}

// Length and seed are per cut: each cut's own length, a fresh seed each.
const PER_CUT_PARAMS = new Set(['duration_seconds', 'seed']);

export function GenerateAllVideosDialog({ open, onClose, beatId, scenes, onQueued }) {
  const [provider, setProvider] = useState(null); // 'comfy' | 'fal'
  const [skipExisting, setSkipExisting] = useState(true);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // ComfyUI
  const [comfy, setComfy] = useState(null);
  const [comfyDefaults, setComfyDefaults] = useState(null);
  const [comfyModelId, setComfyModelId] = useState(null);
  const [comfyParams, setComfyParams] = useState({});
  const [consent, setConsent] = useState(false);

  // fal.ai
  const [fal, setFal] = useState(null);
  const [endpoint, setEndpoint] = useState(null);
  const [lastUsed, setLastUsed] = useState(null);
  const [facets, setFacets] = useState({ ...EMPTY_FACETS, start_frame: true, end_frame: true });
  const [search, setSearch] = useState('');
  const [resolution, setResolution] = useState(null);
  const [fps, setFps] = useState(24);
  const [generateAudio, setGenerateAudio] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState(null);
  const refreshPoll = useRef(null);

  const cuts = useMemo(() => (scenes || []).flatMap((s) => s.cuts || []), [scenes]);
  const tally = useMemo(() => {
    const t = { total: cuts.length, noFrames: 0, noPrompt: 0, hasVideo: 0, ready: 0 };
    for (const c of cuts) {
      if (!c.start_frame?.image_id || !c.end_frame?.image_id) t.noFrames += 1;
      else if (!String(c.prompt || '').trim()) t.noPrompt += 1;
      else {
        t.ready += 1;
        if (c.video_file_id) t.hasVideo += 1;
      }
    }
    return t;
  }, [cuts]);
  const willRender = tally.ready - (skipExisting ? tally.hasVideo : 0);

  function stopRefreshPoll() {
    if (refreshPoll.current) clearInterval(refreshPoll.current);
    refreshPoll.current = null;
  }

  useEffect(() => {
    if (!open) {
      stopRefreshPoll();
      setRefreshing(false);
      return undefined;
    }
    let cancelled = false;
    setError(null);
    setConsent(false);
    setSearch('');
    setFacets({ ...EMPTY_FACETS, start_frame: true, end_frame: true });
    const stored = readLastEndpoint();
    setLastUsed(stored);
    (async () => {
      const [reg, defs, falReg] = await Promise.all([
        apiGet('/comfy/models').catch(() => ({ configured: false, models: [] })),
        apiGet('/comfy/defaults').catch(() => null),
        apiGet('/video-models').catch((e) => ({ configured: false, models: [], catalog_error: parseError(e) })),
      ]);
      if (cancelled) return;
      setComfy(reg);
      setComfyDefaults(defs || { model_id: null, params_by_model: {} });
      const usable = (reg.models || []).filter((m) => m.available && batchable(m));
      const firstComfy = usable.find((m) => m.id === defs?.model_id) || usable.find((m) => m.kind === 'local') || usable[0] || null;
      setComfyModelId(firstComfy?.id || null);

      setFal(falReg);
      const registered = (falReg.models || []).filter((m) => m.is_registered);
      const firstFal = registered.find((m) => m.endpoint_id === stored)
        || registered.find((m) => m.capabilities?.start_frame === true && m.capabilities?.end_frame === true)
        || registered[0]
        || null;
      setEndpoint(firstFal?.endpoint_id || null);

      const comfyReady = reg.configured && (reg.server ? reg.server.running : true) && firstComfy;
      setProvider(comfyReady || !falReg.configured ? 'comfy' : 'fal');
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => () => stopRefreshPoll(), []);

  const comfyModels = comfy?.models || [];
  const comfyModel = comfyModels.find((m) => m.id === comfyModelId) || null;
  useEffect(() => {
    if (!comfyModel) return;
    setComfyParams(defaultParamsFor(comfyModel, comfyDefaults?.params_by_model?.[comfyModel.id]));
    setConsent(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comfyModel?.id, comfyDefaults]);

  const falModel = useMemo(() => (fal?.models || []).find((m) => m.endpoint_id === endpoint) || null, [fal, endpoint]);
  useEffect(() => {
    if (!falModel) return;
    setResolution(pickDefaultResolution(falModel));
    setFps(pickDefaultFps(falModel));
    setGenerateAudio(false);
  }, [falModel]);

  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = fal?.models || [];
    return q ? list.filter((m) => modelSearchText(m).includes(q)) : list;
  }, [fal, search]);
  const passes = (m, state) => FACETS.filter((f) => state[f.key]).every((f) => m.capabilities?.[f.key] === true);
  const visibleModels = useMemo(() => searched.filter((m) => passes(m, facets)), [searched, facets]);
  const facetCounts = useMemo(() => {
    const out = {};
    for (const f of FACETS) out[f.key] = searched.filter((m) => passes(m, { ...facets, [f.key]: true })).length;
    return out;
  }, [searched, facets]);

  async function refreshCatalog() {
    setError(null);
    try {
      const r = await apiPostJson('/video-models/refresh', {});
      setRefreshProgress(r?.state?.progress || 'Refreshing…');
      setRefreshing(true);
      stopRefreshPoll();
      refreshPoll.current = setInterval(async () => {
        const s = await apiGet('/video-models/refresh').catch(() => null);
        if (!s) return;
        if (s.running) return setRefreshProgress(s.progress || 'Refreshing…');
        stopRefreshPoll();
        setRefreshing(false);
        setRefreshProgress(null);
        if (s.error) setError(`Catalog refresh failed: ${s.error}`);
        apiGet('/video-models').then(setFal).catch(() => {});
      }, 2000);
    } catch (e) {
      setError(parseError(e));
    }
  }

  const comfyConfigured = !!comfy?.configured;
  const comfyUp = comfyConfigured && (comfy?.server ? !!comfy.server.running : true);
  const falConfigured = !!fal?.configured;

  const falMissing = [];
  if (falModel) {
    const need = falModel.inputs || {};
    if (need.characterSheet === 'required') falMissing.push('a character sheet');
    if (need.referenceImages === 'required') falMissing.push('reference images');
    if (need.audio === 'required') falMissing.push('a dialogue recording');
    if (need.videoInput === 'required') falMissing.push('an uploaded video');
  }

  const canQueue = !submitting && willRender > 0 && (
    provider === 'comfy'
      ? comfyUp && !!comfyModel && comfyModel.available && batchable(comfyModel) && (!comfyModel.spends_credits || consent)
      : provider === 'fal'
        ? falConfigured && !!falModel && falModel.is_registered && falMissing.length === 0
        : false
  );

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = { beat_id: beatId, provider, skip_existing: skipExisting };
      if (provider === 'comfy') {
        body.model_id = comfyModel.id;
        body.params = Object.fromEntries(Object.entries(comfyParams).filter(([k, v]) => !PER_CUT_PARAMS.has(k) && v !== null && v !== ''));
        if (comfyModel.spends_credits) body.confirm_spend = consent;
      } else {
        body.model_id = falModel.id;
        if (shouldShowResolution(falModel) && resolution) body.resolution = resolution;
        if (shouldShowFps(falModel) && Number.isFinite(fps) && fps > 0) body.fps = fps;
        if (falModel.supports_generate_audio) body.generate_audio = generateAudio;
      }
      const r = await apiPostJson('/cuts/videos/generate-all', body);
      if (provider === 'fal') writeLastEndpoint(falModel.endpoint_id);
      onQueued?.(r?.batch || null);
      onClose?.();
    } catch (e) {
      setError(parseError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const footer = (
    <>
      <button type="button" onClick={onClose}>Cancel</button>
      <button type="button" className="primary" disabled={!canQueue} onClick={submit}>
        {submitting ? 'Queuing…' : `Queue ${willRender} video${willRender === 1 ? '' : 's'}`}
      </button>
    </>
  );

  const local = comfyModels.filter((m) => m.kind === 'local');
  const api = comfyModels.filter((m) => m.kind !== 'local');
  const skippedBits = [
    tally.noFrames ? `${tally.noFrames} without both frames` : null,
    tally.noPrompt ? `${tally.noPrompt} without a video prompt` : null,
    skipExisting && tally.hasVideo ? `${tally.hasVideo} that already have a video` : null,
  ].filter(Boolean);

  return (
    <Modal open={open} title="Generate all videos" onClose={onClose} footer={footer} size="xl">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13 }}>
          <b>{willRender}</b> of {tally.total} cut{tally.total === 1 ? '' : 's'} will be generated, one after another, each from its own
          video prompt, start frame, end frame and length.
          {skippedBits.length ? <span style={{ color: 'var(--fg-muted)' }}> Skipped: {skippedBits.join(', ')}.</span> : null}
          <div style={{ color: 'var(--fg-muted)', marginTop: 4 }}>
            The batch runs on the server — close this page and come back; a cut that fails is noted and the rest carry on.
          </div>
        </div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={skipExisting} disabled={submitting} onChange={(e) => setSkipExisting(e.target.checked)} />
          <span>Skip cuts that already have a video{!skipExisting && tally.hasVideo ? ` (${tally.hasVideo} will be replaced)` : ''}</span>
        </label>

        <div className="batch-provider-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={provider === 'comfy'} className={provider === 'comfy' ? 'primary' : ''} disabled={submitting} onClick={() => setProvider('comfy')}>
            ComfyUI
          </button>
          <button type="button" role="tab" aria-selected={provider === 'fal'} className={provider === 'fal' ? 'primary' : ''} disabled={submitting} onClick={() => setProvider('fal')}>
            fal.ai
          </button>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {!provider ? <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Loading models…</div> : null}

        {provider === 'comfy' ? (
          <>
            {comfy && !comfyConfigured ? <div className="error-banner">{COMFY_DISABLED_MESSAGE} The fal.ai path still works.</div> : null}
            {comfyConfigured && !comfyUp ? (
              <div className="error-banner">
                ComfyUI is not reachable{comfy.server?.url ? ` at ${comfy.server.url}` : ''}{comfy.server?.error ? `: ${comfy.server.error}` : '.'}
              </div>
            ) : null}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(320px, 2fr)', gap: 16 }}>
              <div>
                <span className="field-label">Model</span>
                {local.length ? <ModelGroup title="Local (free, your GPU)" models={local} selected={comfyModelId} onPick={setComfyModelId} disabled={submitting} /> : null}
                {api.length ? <ModelGroup title="API (spends Comfy credits)" models={api} selected={comfyModelId} onPick={setComfyModelId} disabled={submitting} /> : null}
                {comfyModel?.notes ? <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 8 }}>{comfyModel.notes}</div> : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {comfyModel && !batchable(comfyModel) ? (
                  <div className="error-banner">
                    {comfyModel.label} needs reference images or a dialogue recording, which a cut does not carry.
                  </div>
                ) : null}
                {comfyModel ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                    {PARAM_ORDER.filter((k) => comfyModel.params?.[k] && !PER_CUT_PARAMS.has(k)).map((key) => (
                      <ParamField
                        key={key}
                        name={key}
                        spec={comfyModel.params[key]}
                        value={comfyParams[key]}
                        disabled={submitting}
                        onChange={(v) => setComfyParams((p) => ({ ...p, [key]: v }))}
                      />
                    ))}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  Length: each cut's own, rounded up to what the model renders. Seed: random per cut. Videos render one at a time on the GPU.
                </div>
                {comfyModel?.spends_credits ? (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={consent} disabled={submitting} onChange={(e) => setConsent(e.target.checked)} />
                    <span>
                      I understand all {willRender} renders run on {comfyModel.lab || 'a partner'}'s servers and spend Comfy credits.
                    </span>
                  </label>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        {provider === 'fal' ? (
          <>
            {fal && !falConfigured ? (
              <div className="error-banner">
                fal.ai is not configured on the server. Set <code>FAL_KEY</code> in your env to enable video generation.
              </div>
            ) : null}
            <ModelPicker
              registry={fal}
              generating={submitting}
              activeFacets={facets}
              facetCounts={facetCounts}
              visibleModels={visibleModels}
              chosenModel={falModel}
              lastUsedEndpoint={lastUsed}
              search={search}
              onSearchChange={setSearch}
              refreshing={refreshing}
              refreshProgress={refreshProgress}
              onToggleFacet={(key) => setFacets((s) => ({ ...s, [key]: !s[key] }))}
              onClearFacets={() => setFacets({ ...EMPTY_FACETS })}
              onModelClick={(m) => setEndpoint(m.endpoint_id)}
              onRefreshCatalog={refreshCatalog}
            />
            {falModel && !falModel.is_registered ? (
              <div className="warn-banner small" style={{ fontSize: 13, color: '#ffb86b' }}>This model is preview-only and cannot be rendered yet.</div>
            ) : null}
            {falMissing.length ? (
              <div className="warn-banner small" style={{ fontSize: 13, color: '#ffb86b' }}>
                This model needs <b>{falMissing.join(', ')}</b>, which a cut does not have.
              </div>
            ) : null}
            <div className="video-action-row">
              {falModel && shouldShowResolution(falModel) ? (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="field-label">Resolution</span>
                  <select value={resolution ?? ''} disabled={submitting} onChange={(e) => setResolution(e.target.value || null)}>
                    {resolutionOptions(falModel).map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
              ) : null}
              {falModel && shouldShowFps(falModel) ? (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="field-label">FPS</span>
                  <select value={fps} disabled={submitting} onChange={(e) => setFps(Number(e.target.value))}>
                    {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
              ) : null}
              {falModel?.supports_generate_audio ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={generateAudio} disabled={submitting} onChange={(e) => setGenerateAudio(e.target.checked)} />
                  <span className="field-label" style={{ margin: 0 }}>Generate audio from prompt</span>
                </label>
              ) : null}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Length: each cut's own, snapped to what the model renders. fal.ai bills every clip — {willRender} render{willRender === 1 ? '' : 's'} with this model.
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

// A cut is a prompt and two frames: a model that needs more cannot be batched.
function batchable(model) {
  return model?.inputs?.referenceImages !== 'required' && model?.inputs?.audio !== 'required';
}
