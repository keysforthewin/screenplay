import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson, apiPutJson, thumbUrl } from '../api.js';
import { VideoProgressBar } from './VideoProgressBar.jsx';
import { ModelGroup, COMFY_DISABLED_MESSAGE } from './comfyControls.jsx';
import { isComfyJobActive, useComfyCutJobs } from './comfyCutJobs.jsx';

// ComfyUI render dialog for one cut (Scenes tab). The server's model
// registry (/api/comfy/models) lists the templates it can drive; each carries
// the canonical parameters it exposes with ranges and defaults. Advanced
// opens the template's raw slot list so any parameter can be set. The prompt
// shown is the cut's video prompt and can be overridden for this render only.
//
// The render itself is a background job: its live snapshot lives in the
// page's ComfyUI job store (comfyCutJobs.jsx), not here, so the dialog can be
// closed at any time and reopening it shows the progress. Other cuts can be
// queued meanwhile; they run one after another on the GPU.

export const PARAM_ORDER = [
  'negative_prompt',
  'duration_seconds',
  'aspect_ratio',
  'megapixels',
  'width',
  'height',
  'resolution',
  'fps',
  'seed',
  'steps',
  'cfg',
  'generate_audio',
  'prompt_enhance',
];

function parseError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

function parseErrorBody(e) {
  try {
    return JSON.parse(e?.message || '');
  } catch {
    return null;
  }
}

function idOf(v) {
  return v ? v.toString?.() || String(v) : null;
}

// The length and the seed belong to one render, never to the remembered
// defaults: a blank length means "this cut's own" (the server adds a
// travelling camera's handles and snaps to the model), a blank seed is random.
const PER_RENDER_PARAMS = ['duration_seconds', 'seed'];

export function defaultParamsFor(model, remembered) {
  const out = {};
  for (const [key, spec] of Object.entries(model?.params || {})) {
    if (key === 'prompt') continue;
    if (PER_RENDER_PARAMS.includes(key)) {
      out[key] = null;
      continue;
    }
    const r = remembered?.[key];
    out[key] = r !== undefined ? r : spec.default ?? null;
  }
  return out;
}

// What a blank length renders, for the hint under the field.
function autoLengthHint(model, cut) {
  const d = Number(cut?.duration_seconds);
  if (!(d > 0)) return `auto: the model default (${model?.params?.duration_seconds?.default ?? '?'} s)`;
  return `auto: this cut's ${d} s, rounded up to what the model renders`;
}

// The prompt the server will send, so the textarea is populated before the
// first preview round trip.
function assemblePromptClient(model, cut) {
  return String(cut?.prompt || '').trim();
}

function coerceSlotValue(slot, raw) {
  const t = String(slot?.type || '').toUpperCase();
  if (t === 'INT') {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : raw;
  }
  if (t === 'FLOAT' || t === 'FLOAT,INT') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (t === 'BOOLEAN') {
    if (typeof raw === 'boolean') return raw;
    return String(raw).trim().toLowerCase() === 'true';
  }
  return raw;
}

export function ComfyVideoDialog({ open, onClose, cut, beatId, onRefresh }) {
  const cutId = idOf(cut?._id);
  const [registry, setRegistry] = useState(null);
  const [registryError, setRegistryError] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [modelId, setModelId] = useState(null);
  const [params, setParams] = useState({});
  const [promptText, setPromptText] = useState('');
  const [promptTouched, setPromptTouched] = useState(false);
  const [consent, setConsent] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [slots, setSlots] = useState(null);
  const [slotsError, setSlotsError] = useState(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [advanced, setAdvanced] = useState({}); // address → value
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const store = useComfyCutJobs();
  const job = cutId ? store?.jobs?.[cutId] || null : null;
  // While this cut's job is queued or rendering, the form is read-only.
  const generating = submitting || isComfyJobActive(job);

  const models = registry?.models || [];
  const model = useMemo(() => models.find((m) => m.id === modelId) || null, [models, modelId]);
  const configured = !!registry?.configured;
  const serverRunning = registry?.server ? !!registry.server.running : configured;
  const startFrameId = idOf(cut?.start_frame?.image_id);
  const needsStart = model?.inputs?.startFrame === 'required';
  const needsRefs = model?.inputs?.referenceImages === 'required';
  // A cut carries a prompt and two frames; models that need more (reference
  // images, a dialogue recording) cannot be driven from here.
  const refCount = 0;
  const needsAudio = model?.inputs?.audio === 'required';
  const missingStart = needsStart && !startFrameId;
  const endFrameId = idOf(cut?.end_frame?.image_id);
  const missingEnd = model?.inputs?.endFrame === 'required' && !endFrameId;
  const missingRefs = needsRefs && refCount === 0;
  // Keyframes with a picture: a keyframe model renders them, others ignore them.
  const keyframes = (cut?.keyframes || []).filter((k) => k.image_id).slice().sort((a, b) => a.at_seconds - b.at_seconds);
  const usesKeyframes = !!model?.inputs?.keyframes && model.inputs.keyframes !== 'unused';
  // A builder model emits its own graph: there is no template and no slots.
  const builder = !!model?.graph;

  // Load registry + defaults on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setPreview(null);
    setConsent(false);
    setPromptTouched(false);
    setAdvanced({});
    setSlots(null);
    setAdvancedOpen(false);
    (async () => {
      try {
        const [reg, defs, vd] = await Promise.all([
          apiGet('/comfy/models'),
          apiGet('/comfy/defaults').catch(() => null),
          apiGet('/video-default').catch(() => null),
        ]);
        if (cancelled) return;
        setRegistry(reg);
        setDefaults(defs || { model_id: null, params_by_model: {} });
        const list = reg?.models || [];
        // The admin's default video renderer (Admin → Video renderer) wins;
        // then the model this project last rendered with; then the first local one.
        const adminDefault = vd?.default?.provider === 'comfy' ? list.find((m) => m.id === vd.default.model_id && m.available) : null;
        const remembered = list.find((m) => m.id === defs?.model_id && m.available);
        const first = adminDefault || remembered || list.find((m) => m.available && m.kind === 'local') || list.find((m) => m.available) || null;
        setModelId(first?.id || null);
      } catch (e) {
        if (!cancelled) setRegistryError(parseError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Re-seed params + prompt whenever the model changes.
  useEffect(() => {
    if (!model) return;
    setParams(defaultParamsFor(model, defaults?.params_by_model?.[model.id]));
    setSlots(null);
    setAdvanced({});
    setPreview(null);
    if (!promptTouched) setPromptText(assemblePromptClient(model, cut));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id, defaults]);

  useEffect(() => {
    if (!open || !model || !advancedOpen || slots || slotsLoading) return;
    setSlotsLoading(true);
    setSlotsError(null);
    apiGet(`/comfy/models/${encodeURIComponent(model.id)}/slots`)
      .then((r) => setSlots(Array.isArray(r?.slots) ? r.slots : []))
      .catch((e) => setSlotsError(parseError(e)))
      .finally(() => setSlotsLoading(false));
  }, [open, model, advancedOpen, slots, slotsLoading]);

  function setParam(key, value) {
    setParams((p) => ({ ...p, [key]: value }));
    setPreview(null);
  }

  function buildBody() {
    const body = { model_id: model.id, params: { ...params } };
    if (promptTouched && promptText.trim()) body.prompt = promptText.trim();
    const adv = Object.entries(advanced)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([address, value]) => ({ address, value }));
    if (adv.length) body.advanced = adv;
    if (model.spends_credits) body.confirm_spend = consent;
    return body;
  }

  async function loadPreview() {
    if (!model || !cutId) return;
    setError(null);
    setPreviewLoading(true);
    try {
      const r = await apiPostJson(`/cut/${cutId}/video/preview`, buildBody());
      setPreview(r);
      if (!promptTouched && r?.prompt) setPromptText(r.prompt);
    } catch (e) {
      setError(parseError(e));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function submit() {
    if (!model || !cutId || !store) return;
    setError(null);
    setSubmitting(true);
    try {
      const r = await apiPostJson(`/cut/${cutId}/video/generate`, buildBody());
      if (!r?.job_id) {
        setError('Server did not return a job id.');
        return;
      }
      store.track(cutId, r.job_id);
      apiPutJson('/comfy/defaults', { model_id: model.id, params_by_model: { [model.id]: params } }).catch(() => {});
    } catch (e) {
      // Already queued or rendering (e.g. from another tab): follow that job.
      const body = parseErrorBody(e);
      if (body?.code === 'CUT_BUSY' && body.job_id) store.track(cutId, body.job_id);
      else setError(parseError(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeFromQueue() {
    setError(null);
    try {
      await store?.cancel(cutId);
    } catch (e) {
      setError(parseError(e));
    }
  }

  const canGenerate =
    !!model && model.available && configured && serverRunning && !generating && !missingStart && !missingEnd && !missingRefs && !needsAudio &&
    (!model.spends_credits || consent);

  const footer = (
    <>
      <button type="button" onClick={loadPreview} disabled={!model || previewLoading || generating || !configured}>
        {previewLoading ? 'Previewing…' : 'Preview payload'}
      </button>
      {job?.status === 'queued' ? (
        <button type="button" className="danger" onClick={removeFromQueue}>
          Remove from queue
        </button>
      ) : null}
      <button type="button" className="primary" onClick={submit} disabled={!canGenerate}>
        {job?.status === 'queued'
          ? `Queued${job.queue_position ? ` #${job.queue_position}` : ''}…`
          : generating
            ? 'Rendering…'
            : model?.spends_credits
              ? 'Generate (spends credits)'
              : 'Generate video'}
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </>
  );

  const local = models.filter((m) => m.kind === 'local');
  const api = models.filter((m) => m.kind !== 'local');

  return (
    <Modal open={open} title="Generate video with ComfyUI" onClose={onClose} footer={footer} size="xl">
      {job ? (
        <div style={{ marginBottom: 12 }}>
          <VideoProgressBar job={job} />
          {isComfyJobActive(job) ? (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
              Runs in the background — close this and queue other cuts; reopen it to check on this one.
            </div>
          ) : job.status === 'done' ? (
            <div style={{ fontSize: 13, color: 'var(--ok)', marginTop: 4 }}>Clip saved to the cut.</div>
          ) : null}
        </div>
      ) : null}
      {registryError ? <div className="error-banner">{registryError}</div> : null}
      {registry && !configured ? (
        <div className="error-banner">
          {COMFY_DISABLED_MESSAGE} The fal.ai path still works.
        </div>
      ) : null}
      {registry && configured && registry.server && !registry.server.running ? (
        <div className="error-banner">
          ComfyUI is not reachable{registry.server.url ? ` at ${registry.server.url}` : ''}
          {registry.server.error ? `: ${registry.server.error}` : '.'}
        </div>
      ) : null}
      {registry?.server?.running ? (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 8 }}>
          ComfyUI at {registry.server.url}
          {registry.server.gpu ? ` · ${registry.server.gpu}` : ''}
          {registry.server.vram_bytes ? ` · ${Math.round(registry.server.vram_bytes / 2 ** 30)} GB` : ''}
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(320px, 2fr)', gap: 16 }}>
        <div>
          <span className="field-label">Model</span>
          {!registry ? <div style={{ fontSize: 13, color: 'var(--fg-muted)' }}>Loading models…</div> : null}
          {local.length ? <ModelGroup title="Local (free, your GPU)" models={local} selected={modelId} onPick={setModelId} disabled={generating} /> : null}
          {api.length ? <ModelGroup title="API (spends Comfy credits)" models={api} selected={modelId} onPick={setModelId} disabled={generating} /> : null}
          {model?.notes ? (
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 8 }}>{model.notes}</div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <InputsStrip
            model={model}
            startFrameId={startFrameId}
            endFrameId={endFrameId}
            missingStart={missingStart}
            missingEnd={missingEnd}
            missingRefs={missingRefs}
            keyframes={keyframes}
            usesKeyframes={usesKeyframes}
          />

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="field-label">
              Prompt sent to the model{promptTouched ? ' (edited for this render)' : ''}
            </span>
            <textarea
              value={promptText}
              rows={8}
              disabled={generating}
              onChange={(e) => {
                setPromptText(e.target.value);
                setPromptTouched(true);
                setPreview(null);
              }}
            />
          </label>

          {model ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
              {PARAM_ORDER.filter((k) => model.params?.[k]).map((key) => (
                <ParamField
                  key={key}
                  name={key}
                  spec={model.params[key]}
                  value={params[key]}
                  disabled={generating}
                  placeholder={key === 'duration_seconds' ? 'auto' : undefined}
                  hint={key === 'duration_seconds' && params[key] == null ? autoLengthHint(model, cut) : null}
                  onChange={(v) => setParam(key, v)}
                />
              ))}
            </div>
          ) : null}

          {model?.spends_credits ? (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={consent} disabled={generating} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                I understand this render runs on {model.lab || 'a partner'}'s servers and spends Comfy credits.
              </span>
            </label>
          ) : null}

          {builder ? null : <div>
            <button type="button" onClick={() => setAdvancedOpen((v) => !v)} disabled={!model || generating}>
              {advancedOpen ? 'Hide advanced slots' : 'Advanced slots…'}
            </button>
            {advancedOpen ? (
              <AdvancedSlots
                slots={slots}
                loading={slotsLoading}
                error={slotsError}
                values={advanced}
                disabled={generating}
                onChange={(address, slot, raw) => {
                  setAdvanced((a) => {
                    const next = { ...a };
                    if (raw === '' || raw === undefined) delete next[address];
                    else next[address] = coerceSlotValue(slot, raw);
                    return next;
                  });
                  setPreview(null);
                }}
              />
            ) : null}
          </div>}

          {preview ? <PreviewPanel preview={preview} /> : null}
          {error ? <div className="error-banner">{error}</div> : null}
        </div>
      </div>
    </Modal>
  );
}

function InputsStrip({ model, startFrameId, endFrameId, missingStart, missingEnd, missingRefs, keyframes = [], usesKeyframes = false }) {
  if (!model) return null;
  const usesStart = model.inputs?.startFrame && model.inputs.startFrame !== 'unused';
  const usesEnd = model.inputs?.endFrame && model.inputs.endFrame !== 'unused';
  const usesAudio = model.inputs?.audio === 'required';
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {usesAudio ? (
        <div style={{ fontSize: 12, color: '#ffb86b', maxWidth: 260 }}>
          This model lip-syncs a dialogue recording, which a cut does not carry. Pick another model.
        </div>
      ) : null}
      {missingRefs ? (
        <div style={{ fontSize: 12, color: '#ffb86b', maxWidth: 260 }}>
          This model is driven by reference images rather than a start and end frame. Pick another model.
        </div>
      ) : null}
      {usesStart ? (
        <div>
          <span className="field-label">Start frame</span>
          {startFrameId ? (
            <img src={thumbUrl(startFrameId)} alt="Start frame" style={{ width: 160, borderRadius: 4, display: 'block' }} />
          ) : (
            <div style={{ fontSize: 12, color: missingStart ? '#ffb86b' : 'var(--fg-muted)', maxWidth: 220 }}>
              {missingStart ? 'This model needs a start frame — render the cut\'s start frame first.' : 'No start frame yet (optional for this model).'}
            </div>
          )}
        </div>
      ) : null}
      {usesKeyframes ? (
        <div>
          <span className="field-label">Keyframes</span>
          {keyframes.length ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 420 }}>
              {keyframes.map((k) => (
                <div key={String(k.id)} style={{ textAlign: 'center', fontSize: 11, color: 'var(--fg-muted)' }}>
                  <img src={thumbUrl(String(k.image_id))} alt={`Keyframe at ${k.at_seconds} s`} style={{ width: 96, borderRadius: 4, display: 'block' }} />
                  t = {k.at_seconds} s{k.strength != null ? ` · ${k.strength}` : ''}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', maxWidth: 220 }}>No keyframes with an image — the clip is pinned by the two frames only.</div>
          )}
        </div>
      ) : keyframes.length ? (
        <div style={{ fontSize: 12, color: '#ffb86b', maxWidth: 260 }}>
          This model ignores the {keyframes.length} keyframe{keyframes.length === 1 ? '' : 's'} of this cut — only a keyframe model (LTX-2.5 keyframes) renders them.
        </div>
      ) : null}
      {usesEnd ? (
        <div>
          <span className="field-label">End frame</span>
          {endFrameId ? (
            <img src={thumbUrl(endFrameId)} alt="End frame" style={{ width: 160, borderRadius: 4, display: 'block' }} />
          ) : (
            <div style={{ fontSize: 12, color: missingEnd ? '#ffb86b' : 'var(--fg-muted)', maxWidth: 220 }}>
              {missingEnd ? 'This model lands on an end frame — render the cut\'s end frame first.' : 'No end frame yet (optional for this model).'}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ParamField({ name, spec, value, disabled, onChange, placeholder, hint = null }) {
  const label = spec.label || name;
  const help = hint || spec.help || '';
  if (spec.type === 'bool') {
    return (
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }} title={help}>
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    );
  }
  if (Array.isArray(spec.enum) && spec.enum.length) {
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }} title={help}>
        <span className="field-label">{label}</span>
        <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {spec.enum.map((opt) => (
            <option key={String(opt)} value={opt}>
              {String(opt)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.type === 'int' || spec.type === 'float') {
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }} title={help}>
        <span className="field-label">
          {label}
          {typeof spec.min === 'number' && typeof spec.max === 'number' && name !== 'seed' ? (
            <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}> {spec.min}–{spec.max}</span>
          ) : null}
        </span>
        <input
          type="number"
          value={value ?? ''}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? (spec.type === 'int' ? 1 : 'any')}
          placeholder={placeholder ?? (name === 'seed' ? 'random' : '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
        {help ? <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{help}</span> : null}
      </label>
    );
  }
  const long = name === 'negative_prompt' || name === 'prompt';
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: long ? '1 / -1' : undefined }} title={help}>
      <span className="field-label">{label}</span>
      {long ? (
        <textarea value={value ?? ''} rows={2} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type="text" value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      )}
      {help ? <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{help}</span> : null}
    </label>
  );
}

function AdvancedSlots({ slots, loading, error, values, disabled, onChange }) {
  const [filter, setFilter] = useState('');
  if (loading) return <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 6 }}>Loading the template's slots…</div>;
  if (error) return <div className="error-banner" style={{ marginTop: 6 }}>{error}</div>;
  if (!slots) return null;
  const q = filter.trim().toLowerCase();
  const rows = slots.filter((s) => !q || `${s.address} ${s.node_type} ${s.name}`.toLowerCase().includes(q));
  return (
    <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 4, padding: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <input
          type="text"
          placeholder="Filter slots (address, node, name)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {rows.length}/{slots.length} · overrides: {Object.keys(values).length}
        </span>
      </div>
      <div style={{ maxHeight: 260, overflow: 'auto', fontSize: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--fg-muted)', textAlign: 'left' }}>
              <th style={{ padding: '2px 4px' }}>Address</th>
              <th style={{ padding: '2px 4px' }}>Node</th>
              <th style={{ padding: '2px 4px' }}>Current</th>
              <th style={{ padding: '2px 4px' }}>Override</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const cur = s.current_value;
              const curText = cur === null || cur === undefined ? '' : typeof cur === 'string' ? cur : JSON.stringify(cur);
              const override = values[s.address];
              return (
                <tr key={s.address} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '2px 4px', fontFamily: 'monospace', whiteSpace: 'nowrap' }} title={s.linked_from ? 'link-driven: an override may be ignored' : ''}>
                    {s.address}
                    {s.linked_from ? ' ⛓' : ''}
                  </td>
                  <td style={{ padding: '2px 4px', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{s.node_type}</td>
                  <td style={{ padding: '2px 4px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={curText}>
                    {curText}
                  </td>
                  <td style={{ padding: '2px 4px' }}>
                    {Array.isArray(s.enum) && s.enum.length ? (
                      <select
                        value={override === undefined ? '' : String(override)}
                        disabled={disabled}
                        onChange={(e) => onChange(s.address, s, e.target.value)}
                      >
                        <option value="">(keep)</option>
                        {s.enum.map((opt) => (
                          <option key={String(opt)} value={String(opt)}>
                            {String(opt)}
                          </option>
                        ))}
                      </select>
                    ) : String(s.type).toUpperCase() === 'BOOLEAN' ? (
                      <select
                        value={override === undefined ? '' : String(override)}
                        disabled={disabled}
                        onChange={(e) => onChange(s.address, s, e.target.value)}
                      >
                        <option value="">(keep)</option>
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={override === undefined ? '' : String(override)}
                        placeholder="(keep)"
                        disabled={disabled}
                        onChange={(e) => onChange(s.address, s, e.target.value)}
                        style={{ width: '100%' }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewPanel({ preview }) {
  return (
    <details open style={{ fontSize: 12 }}>
      <summary style={{ cursor: 'pointer' }}>
        Payload preview · {preview.workflow ? `built graph (${Object.keys(preview.workflow).length} nodes)` : `${preview.overrides?.length || 0} slot overrides`}
        {preview.keyframes?.length ? ` · ${preview.keyframes.length} keyframe${preview.keyframes.length === 1 ? '' : 's'}` : ''}
        {preview.ignored_keyframes ? ` · ${preview.ignored_keyframes} ignored` : ''}
        {preview.spends_credits ? ' · spends credits' : ''}
      </summary>
      {preview.warnings?.length ? (
        <ul style={{ margin: '6px 0', paddingLeft: 18, color: '#ffb86b' }}>
          {preview.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      {preview.keyframes?.length ? (
        <div style={{ margin: '6px 0' }}>
          Guides: {preview.keyframes.map((k) => `${k.at_seconds} s → frame ${k.frame_idx} (strength ${k.strength})`).join(' · ')}
          {preview.frames ? ` · ${preview.frames} frames` : ''}
        </div>
      ) : null}
      <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 11, margin: '6px 0 0' }}>
        {JSON.stringify(preview.workflow || preview.overrides, null, 2)}
      </pre>
    </details>
  );
}
