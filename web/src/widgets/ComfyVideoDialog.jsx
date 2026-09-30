import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson, apiPutJson, apiSseUrl, thumbUrl } from '../api.js';
import { VideoProgressBar } from './VideoProgressBar.jsx';
import { ModelGroup, COMFY_DISABLED_MESSAGE } from './comfyControls.jsx';

// ComfyUI render dialog for one cut (Prompts tab). The server's model
// registry (/api/comfy/models) lists the templates it can drive; each carries
// the canonical parameters it exposes with ranges and defaults. Advanced
// opens the template's raw slot list so any parameter can be set. The prompt
// shown is the server's assembly of the cut (binding + block + exclusions)
// and can be overridden for this render only.

const PARAM_ORDER = [
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

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

function idOf(v) {
  return v ? v.toString?.() || String(v) : null;
}

function defaultParamsFor(model, remembered) {
  const out = {};
  for (const [key, spec] of Object.entries(model?.params || {})) {
    if (key === 'prompt') continue;
    const r = remembered?.[key];
    out[key] = r !== undefined ? r : spec.default ?? null;
  }
  return out;
}

// Client-side twin of the server's assembly so the textarea is populated
// before the first preview round trip.
function assemblePromptClient(model, cut) {
  const takesRefs = model?.inputs?.referenceImages && model.inputs.referenceImages !== 'unused';
  const parts = [];
  const binding = String(cut?.reference_binding || '').trim();
  if (takesRefs && binding) parts.push(binding);
  const body = String(cut?.prompt || '').trim();
  if (body) parts.push(body);
  const ex = (Array.isArray(cut?.exclusions) ? cut.exclusions : []).map((x) => String(x || '').trim()).filter(Boolean);
  if (ex.length) parts.push(ex.join(' '));
  return parts.join('\n\n');
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
  const [job, setJob] = useState(null);
  const [generating, setGenerating] = useState(false);
  const esRef = useRef(null);

  const models = registry?.models || [];
  const model = useMemo(() => models.find((m) => m.id === modelId) || null, [models, modelId]);
  const configured = !!registry?.configured;
  const serverRunning = registry?.server ? !!registry.server.running : configured;
  const startFrameId = idOf(cut?.start_frame?.image_id);
  const needsStart = model?.inputs?.startFrame === 'required';
  const needsRefs = model?.inputs?.referenceImages === 'required';
  const refCount = Array.isArray(cut?.reference_images) ? cut.reference_images.length : 0;
  const missingStart = needsStart && !startFrameId;
  const endFrameId = idOf(cut?.end_frame?.image_id);
  const missingEnd = model?.inputs?.endFrame === 'required' && !endFrameId;
  const missingRefs = needsRefs && refCount === 0;

  function closeStream() {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }

  // Load registry + defaults on open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setPreview(null);
    setJob(null);
    setGenerating(false);
    setConsent(false);
    setPromptTouched(false);
    setAdvanced({});
    setSlots(null);
    setAdvancedOpen(false);
    (async () => {
      try {
        const [reg, defs] = await Promise.all([apiGet('/comfy/models'), apiGet('/comfy/defaults').catch(() => null)]);
        if (cancelled) return;
        setRegistry(reg);
        setDefaults(defs || { model_id: null, params_by_model: {} });
        const list = reg?.models || [];
        const remembered = list.find((m) => m.id === defs?.model_id && m.available);
        const first = remembered || list.find((m) => m.available && m.kind === 'local') || list.find((m) => m.available) || null;
        setModelId(first?.id || null);
      } catch (e) {
        if (!cancelled) setRegistryError(parseError(e));
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
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
    if (!model || !cutId) return;
    setError(null);
    setJob({ status: 'queued', step: 'Queued', started_at: new Date().toISOString() });
    setGenerating(true);
    try {
      const r = await apiPostJson(`/cut/${cutId}/video/generate`, buildBody());
      const jobId = r?.job_id;
      if (!jobId) {
        setGenerating(false);
        setError('Server did not return a job id.');
        return;
      }
      apiPutJson('/comfy/defaults', { model_id: model.id, params_by_model: { [model.id]: params } }).catch(() => {});
      const es = new EventSource(apiSseUrl(`/cut/${cutId}/video-job/${jobId}/events`));
      esRef.current = es;
      es.addEventListener('snapshot', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('update', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('done', (ev) => {
        setJob(safeParse(ev.data));
        setGenerating(false);
        closeStream();
        onRefresh?.();
      });
      es.addEventListener('error', (ev) => {
        const snap = ev?.data ? safeParse(ev.data) : null;
        if (snap) setJob(snap);
        else setJob((j) => (j && j.status !== 'done' ? { ...j, status: 'error', error: j.error || 'Connection lost.' } : j));
        setGenerating(false);
        closeStream();
        onRefresh?.();
      });
    } catch (e) {
      setGenerating(false);
      setJob(null);
      setError(parseError(e));
    }
  }

  const canGenerate =
    !!model && model.available && configured && serverRunning && !generating && !missingStart && !missingEnd && !missingRefs &&
    (!model.spends_credits || consent);

  const footer = (
    <>
      <button type="button" onClick={loadPreview} disabled={!model || previewLoading || generating || !configured}>
        {previewLoading ? 'Previewing…' : 'Preview payload'}
      </button>
      <button type="button" className="primary" onClick={submit} disabled={!canGenerate}>
        {generating ? 'Rendering…' : model?.spends_credits ? 'Generate (spends credits)' : 'Generate video'}
      </button>
      <button type="button" onClick={onClose} disabled={generating}>
        Close
      </button>
    </>
  );

  const local = models.filter((m) => m.kind === 'local');
  const api = models.filter((m) => m.kind !== 'local');

  return (
    <Modal open={open} title="Generate video with ComfyUI" onClose={onClose} dismissible={!generating} footer={footer} size="xl">
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
            cut={cut}
            startFrameId={startFrameId}
            endFrameId={endFrameId}
            refCount={refCount}
            missingStart={missingStart}
            missingEnd={missingEnd}
            missingRefs={missingRefs}
            audio={preview?.audio || null}
            audioError={model?.inputs?.audio === 'required' && error && /recording|dialogue/i.test(error) ? error : null}
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

          <div>
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
          </div>

          {preview ? <PreviewPanel preview={preview} /> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          {job ? <VideoProgressBar job={job} /> : null}
          {job?.status === 'done' ? (
            <div style={{ fontSize: 13, color: 'var(--ok)' }}>Clip saved to the cut. Close to see it.</div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function InputsStrip({ model, cut, startFrameId, endFrameId, refCount, missingStart, missingEnd, missingRefs, audio, audioError }) {
  if (!model) return null;
  const refs = Array.isArray(cut?.reference_images) ? cut.reference_images : [];
  const usesStart = model.inputs?.startFrame && model.inputs.startFrame !== 'unused';
  const usesEnd = model.inputs?.endFrame && model.inputs.endFrame !== 'unused';
  const usesRefs = model.inputs?.referenceImages && model.inputs.referenceImages !== 'unused';
  const usesAudio = model.inputs?.audio === 'required';
  const coveredCount = Array.isArray(cut?.dialog_ids) ? cut.dialog_ids.length : 0;
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {usesAudio ? (
        <div>
          <span className="field-label">Dialogue (lip-sync)</span>
          {audio ? (
            <div style={{ fontSize: 12 }}>
              {audio.lines} line{audio.lines === 1 ? '' : 's'} recorded · {Number(audio.speech_seconds || 0).toFixed(1)} s joined
            </div>
          ) : (
            <div style={{ fontSize: 12, color: audioError || !coveredCount ? '#ffb86b' : 'var(--fg-muted)', maxWidth: 260 }}>
              {audioError
                ? audioError
                : coveredCount
                  ? `${coveredCount} covered line${coveredCount === 1 ? '' : 's'} — every one must be recorded; the recordings are joined and drive the mouth.`
                  : 'This cut covers no dialogue lines — a lip-sync model has nothing to sync.'}
            </div>
          )}
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
      {usesRefs ? (
        <div>
          <span className="field-label">References (@Image order)</span>
          {refs.length ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {refs.slice(0, model.max_reference_images || refs.length).map((r, i) => (
                <div key={idOf(r.image_id) || i} style={{ textAlign: 'center', fontSize: 10, color: 'var(--fg-muted)' }}>
                  <img src={thumbUrl(idOf(r.image_id))} alt={r.label || ''} style={{ width: 72, borderRadius: 3, display: 'block' }} />
                  @Image{i + 1}
                </div>
              ))}
              {refs.length > (model.max_reference_images || refs.length) ? (
                <div style={{ fontSize: 11, color: 'var(--fg-muted)', alignSelf: 'center' }}>
                  +{refs.length - model.max_reference_images} not sent (template slots)
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: missingRefs ? '#ffb86b' : 'var(--fg-muted)' }}>
              {missingRefs ? 'This model needs at least one reference image on the cut.' : 'No references on this cut.'}
            </div>
          )}
          {refCount === 0 ? null : null}
        </div>
      ) : null}
    </div>
  );
}

function ParamField({ name, spec, value, disabled, onChange }) {
  const label = spec.label || name;
  const help = spec.help || '';
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
          placeholder={name === 'seed' ? 'random' : ''}
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
        Payload preview · {preview.overrides?.length || 0} slot overrides
        {preview.spends_credits ? ' · spends credits' : ''}
      </summary>
      {preview.warnings?.length ? (
        <ul style={{ margin: '6px 0', paddingLeft: 18, color: '#ffb86b' }}>
          {preview.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 11, margin: '6px 0 0' }}>
        {JSON.stringify(preview.overrides, null, 2)}
      </pre>
    </details>
  );
}
