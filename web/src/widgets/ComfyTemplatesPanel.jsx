// Admin page → ComfyUI templates: search the ComfyUI gallery, auto-map a
// template's slots onto a registry entry, confirm every mapping in a form,
// and save it — the model then appears in the per-cut ComfyUI dialog and the
// Prompts-tab Render beat dialog at once. Registered models can be removed;
// built-in ones cannot. Needs a configured ComfyUI (dev only today).
import { useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPutJson } from '../api.js';
import { Badge, COMFY_DISABLED_MESSAGE } from './comfyControls.jsx';

const PARAM_ORDER = ['prompt', 'negative_prompt', 'duration_seconds', 'width', 'height', 'aspect_ratio', 'megapixels', 'fps', 'steps', 'cfg', 'seed', 'prompt_enhance'];
const PARAM_TYPES = { prompt: 'string', negative_prompt: 'string', duration_seconds: 'float', width: 'int', height: 'int', aspect_ratio: 'enum', megapixels: 'float', fps: 'int', steps: 'int', cfg: 'float', seed: 'int', prompt_enhance: 'bool' };
const UNUSED = '';

function parseError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error + (Array.isArray(parsed.errors) && parsed.errors.length ? `: ${parsed.errors.join('; ')}` : '');
  } catch {}
  return msg;
}

function slotLabel(s) {
  const v = s.current_value == null ? '' : String(s.current_value);
  return `${s.address} · ${s.node_type || '?'} · ${s.type || ''}${v ? ` · ${v.length > 40 ? `${v.slice(0, 40)}…` : v}` : ''}`;
}

function SlotSelect({ slots, value, onChange, filter = null, allowUnused = true }) {
  const list = useMemo(() => (filter ? slots.filter(filter) : slots), [slots, filter]);
  const known = list.some((s) => s.address === value);
  return (
    <select value={value || UNUSED} onChange={(e) => onChange(e.target.value || null)} style={{ width: '100%' }}>
      {allowUnused ? <option value={UNUSED}>— unused —</option> : null}
      {value && !known ? <option value={value}>{value} (not in listing)</option> : null}
      {list.map((s) => <option key={s.address} value={s.address}>{slotLabel(s)}</option>)}
    </select>
  );
}

export function ComfyTemplatesPanel() {
  const [availability, setAvailability] = useState(null);
  const [registered, setRegistered] = useState(null);
  const [query, setQuery] = useState('');
  const [excludeApi, setExcludeApi] = useState(false);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState(null); // GET /admin/comfy/templates/:name
  const [draft, setDraft] = useState(null); // editable registry entry
  const [loadingDetail, setLoadingDetail] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [a, r] = await Promise.all([apiGet('/comfy/models').catch(() => ({ configured: false })), apiGet('/admin/comfy/models')]);
        if (cancelled) return;
        setAvailability(a);
        setRegistered(r.registered || []);
      } catch (e) {
        if (!cancelled) setError(parseError(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const configured = Boolean(availability?.configured);

  async function search(e) {
    e?.preventDefault?.();
    setSearching(true);
    setError(null);
    try {
      const r = await apiGet(`/admin/comfy/templates?query=${encodeURIComponent(query)}&exclude_api=${excludeApi ? 1 : 0}`);
      setResults(r.templates || []);
    } catch (e2) {
      setError(parseError(e2));
    } finally {
      setSearching(false);
    }
  }

  async function open(name) {
    setLoadingDetail(name);
    setError(null);
    setSaved(null);
    try {
      const r = await apiGet(`/admin/comfy/templates/${encodeURIComponent(name)}`);
      setDetail(r);
      setDraft(r.existing ? withAddresses(r.existing, r.proposal) : r.proposal);
    } catch (e) {
      setError(parseError(e));
    } finally {
      setLoadingDetail(null);
    }
  }

  // describeComfyVideoModel strips addresses for the SPA; when editing an
  // already-registered model start from the proposal's addresses and keep the
  // stored labels/flags.
  function withAddresses(existing, proposal) {
    const params = { ...proposal.params };
    return { ...proposal, id: existing.id, label: existing.label, description: existing.description, notes: existing.notes, params };
  }

  function setParam(key, patch) {
    setDraft((d) => {
      const params = { ...(d.params || {}) };
      if (patch === null) delete params[key];
      else params[key] = { ...(params[key] || { type: PARAM_TYPES[key], default: null }), ...patch };
      return { ...d, params };
    });
  }

  function setImageSlot(role, index, address) {
    setDraft((d) => {
      const slots = (d.imageSlots || []).filter((s) => s.role !== role || s.role === 'reference');
      let next;
      if (role === 'start_frame' || role === 'end_frame') {
        next = slots.filter((s) => s.role !== role);
        if (address) next.unshift({ address, role });
      } else {
        const refs = (d.imageSlots || []).filter((s) => s.role === 'reference');
        if (address) refs[index] = { address, role: 'reference' };
        else refs.splice(index, 1);
        next = [...(d.imageSlots || []).filter((s) => s.role === 'start_frame' || s.role === 'end_frame'), ...refs.filter(Boolean)];
      }
      const refCount = next.filter((s) => s.role === 'reference').length;
      return {
        ...d,
        imageSlots: next,
        maxReferenceImages: refCount,
        inputs: {
          ...d.inputs,
          startFrame: next.some((s) => s.role === 'start_frame') ? d.inputs?.startFrame === 'unused' ? 'required' : d.inputs?.startFrame || 'required' : 'unused',
          endFrame: next.some((s) => s.role === 'end_frame') ? 'required' : 'unused',
          referenceImages: refCount ? (d.inputs?.referenceImages === 'unused' ? 'optional' : d.inputs?.referenceImages) : 'unused',
        },
      };
    });
  }

  function setAudioSlot(address) {
    setDraft((d) => ({
      ...d,
      audioSlots: address ? [{ address, role: 'dialogue' }] : [],
      inputs: { ...d.inputs, audio: address ? 'required' : 'unused' },
    }));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const r = await apiPutJson(`/admin/comfy/models/${encodeURIComponent(draft.id)}`, draft);
      setRegistered(r.registered || []);
      setSaved(r.model?.id || draft.id);
    } catch (e) {
      setError(parseError(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!confirm(`Remove the registered ComfyUI model "${id}"? Cuts already rendered with it keep their clips.`)) return;
    setError(null);
    try {
      const r = await apiDelete(`/admin/comfy/models/${encodeURIComponent(id)}`);
      setRegistered(r.registered || []);
      if (draft?.id === id) setSaved(null);
    } catch (e) {
      setError(parseError(e));
    }
  }

  const slots = detail?.slots || [];
  const builtinInstall = (detail?.installed_as || []).find((m) => m.builtin) || null;
  const stringSlots = (s) => s.type === 'STRING';
  const numberSlots = (s) => s.type === 'INT' || s.type === 'FLOAT';
  const boolSlots = (s) => s.type === 'BOOLEAN';
  const imageSlotsF = (s) => s.node_type === 'LoadImage';
  const audioSlotsF = (s) => s.node_type === 'LoadAudio';
  const startSlot = (draft?.imageSlots || []).find((s) => s.role === 'start_frame')?.address || null;
  const endSlot = (draft?.imageSlots || []).find((s) => s.role === 'end_frame')?.address || null;
  const refSlots = (draft?.imageSlots || []).filter((s) => s.role === 'reference');

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={{ marginTop: 0 }}>ComfyUI templates</h2>
      <p style={{ color: 'var(--fg-muted)' }}>
        Register a video template from the ComfyUI gallery as a model the Prompts tab can render with. The
        mapper proposes which slot is the prompt, the duration, the start frame and so on; confirm each one
        and save. Built-in models cannot be changed here.
      </p>
      {availability && !configured ? (
        <div className="error-banner">{availability.reason || COMFY_DISABLED_MESSAGE} Registered models are listed below but new ones need a configured ComfyUI.</div>
      ) : null}
      {error ? <div className="error-banner">{error}</div> : null}

      <h3 style={{ marginBottom: 6 }}>Registered models</h3>
      {registered === null ? (
        <p style={{ color: 'var(--fg-muted)' }}>Loading…</p>
      ) : registered.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)' }}>None yet — the built-in models are the only ones available.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {registered.map((m) => (
            <li key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong>{m.label}</strong>
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--fg-muted)' }}>{m.id} · {m.template}</span>
              <Badge ok={!m.spends_credits}>{m.spends_credits ? 'Credits' : 'Free'}</Badge>
              {m.inputs?.audio === 'required' ? <Badge>lip-sync</Badge> : null}
              <button type="button" disabled={!configured} onClick={() => open(m.template)} title={configured ? 'Re-map from the template' : COMFY_DISABLED_MESSAGE}>Edit…</button>
              <button type="button" className="danger" onClick={() => remove(m.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <h3 style={{ marginTop: 24, marginBottom: 6 }}>Find a template</h3>
      <form onSubmit={search} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. image to video, lip sync, wan" disabled={!configured} style={{ minWidth: 260 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={excludeApi} onChange={(e) => setExcludeApi(e.target.checked)} /> local only
        </label>
        <button type="submit" className="primary" disabled={!configured || searching}>{searching ? 'Searching…' : 'Search gallery'}</button>
      </form>
      {results ? (
        results.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)' }}>No templates matched.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {results.map((t) => (
              <li key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 500 }}>{t.title}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--fg-muted)' }}>{t.name}</span>
                {t.api ? <Badge>API · credits</Badge> : <Badge ok>Local</Badge>}
                {t.runnable === false ? <Badge>not runnable here</Badge> : t.runnable === true ? <Badge ok>runnable</Badge> : null}
                {(t.installed_as || []).map((m) => (
                  <Badge key={m.id} ok>already installed: {m.label}{m.builtin ? ' (built in)' : ''}</Badge>
                ))}
                <button type="button" disabled={loadingDetail === t.name} onClick={() => open(t.name)}>{loadingDetail === t.name ? 'Loading…' : 'Map…'}</button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {detail && draft ? (
        <div style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 6, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{detail.template.title}</h3>
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--fg-muted)' }}>{detail.template.name}</span>
            <Badge ok={!draft.spends_credits}>{draft.kind === 'api' ? 'API · spends credits' : 'Local · free'}</Badge>
            {detail.local_check?.checked ? (
              <Badge ok={detail.local_check.runnable !== false}>{detail.local_check.runnable !== false ? 'runnable on the target' : 'NOT runnable on the target'}</Badge>
            ) : (
              <Badge>local check unavailable — a bad template fails at render time</Badge>
            )}
          </div>
          {detail.template.description ? <p style={{ margin: 0, color: 'var(--fg-muted)' }}>{detail.template.description}</p> : null}
          {builtinInstall ? (
            <p style={{ margin: 0, color: '#ffb86b' }}>
              Already installed as the built-in model "{builtinInstall.label}" ({builtinInstall.id}) — it is in the render dialogs already, so there is nothing to save.
            </p>
          ) : detail.existing ? (
            <p style={{ margin: 0, color: 'var(--fg-muted)' }}>
              Already installed as "{detail.existing.label}" ({detail.existing.id}). Saving updates that model.
            </p>
          ) : null}
          {(detail.warnings || []).length ? (
            <ul style={{ margin: 0, paddingLeft: 18, color: '#ffb86b' }}>{detail.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          ) : null}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <label className="field-block"><span className="field-label">Model id</span>
              <input type="text" value={draft.id} onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value.trim().toLowerCase() }))} /></label>
            <label className="field-block"><span className="field-label">Label</span>
              <input type="text" value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} /></label>
            <label className="field-block"><span className="field-label">Lab (optional)</span>
              <input type="text" value={draft.lab || ''} onChange={(e) => setDraft((d) => ({ ...d, lab: e.target.value || null }))} /></label>
          </div>
          <label className="field-block"><span className="field-label">Description</span>
            <textarea rows={2} value={draft.description || ''} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} /></label>

          <h4 style={{ margin: '6px 0 0' }}>Media slots</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
            <div className="field-block"><span className="field-label">Start frame (LoadImage)</span>
              <SlotSelect slots={slots} value={startSlot} onChange={(v) => setImageSlot('start_frame', 0, v)} filter={imageSlotsF} /></div>
            <div className="field-block"><span className="field-label">End frame (LoadImage, first-last-frame models)</span>
              <SlotSelect slots={slots} value={endSlot} onChange={(v) => setImageSlot('end_frame', 0, v)} filter={imageSlotsF} /></div>
            {refSlots.map((s, i) => (
              <div key={`${s.address}-${i}`} className="field-block"><span className="field-label">Reference image {i + 1}</span>
                <SlotSelect slots={slots} value={s.address} onChange={(v) => setImageSlot('reference', i, v)} filter={imageSlotsF} /></div>
            ))}
            <div className="field-block"><span className="field-label">Add reference slot</span>
              <SlotSelect slots={slots} value={null} onChange={(v) => v && setImageSlot('reference', refSlots.length, v)} filter={imageSlotsF} /></div>
            <div className="field-block"><span className="field-label">Dialogue audio (LoadAudio → lip-sync)</span>
              <SlotSelect slots={slots} value={draft.audioSlots?.[0]?.address || null} onChange={setAudioSlot} filter={audioSlotsF} /></div>
          </div>

          <h4 style={{ margin: '6px 0 0' }}>Parameters</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
            {PARAM_ORDER.map((key) => {
              const spec = draft.params?.[key] || null;
              const t = PARAM_TYPES[key];
              const filter = t === 'string' ? stringSlots : t === 'bool' ? boolSlots : t === 'enum' ? null : numberSlots;
              return (
                <div key={key} className="field-block">
                  <span className="field-label">{key}{key === 'prompt' || key === 'duration_seconds' ? ' (required)' : ''}</span>
                  <SlotSelect slots={slots} value={spec?.address || null} filter={filter}
                    onChange={(v) => (v ? setParam(key, { address: v, type: t }) : setParam(key, null))} />
                  {spec && t !== 'string' && t !== 'bool' && t !== 'enum' ? (
                    <input type="number" value={spec.default ?? ''} placeholder="default" style={{ marginTop: 4 }}
                      onChange={(e) => setParam(key, { default: e.target.value === '' ? null : Number(e.target.value) })} />
                  ) : null}
                  {spec && key === 'duration_seconds' ? (
                    <select value={spec.unit === 'frames' ? `frames:${spec.frame_rule || ''}` : 'seconds'} style={{ marginTop: 4 }}
                      title="What the slot counts. Frame slots get seconds × fps at render time."
                      onChange={(e) => {
                        const [unit, rule] = e.target.value.split(':');
                        setParam(key, unit === 'frames'
                          ? { unit: 'frames', frame_rule: rule || null, fps: draft.params?.fps?.default ?? spec.fps ?? 16 }
                          : { unit: undefined, frame_rule: undefined, fps: undefined });
                      }}>
                      <option value="seconds">slot counts seconds</option>
                      <option value="frames:4n+1">slot counts frames (Wan: 4n+1)</option>
                      <option value="frames:8n+1">slot counts frames (LTX: 8n+1)</option>
                      <option value="frames:">slot counts frames (any count)</option>
                    </select>
                  ) : null}
                </div>
              );
            })}
          </div>

          <h4 style={{ margin: '6px 0 0' }}>Output</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
            <div className="field-block"><span className="field-label">filename_prefix (SaveVideo)</span>
              <SlotSelect slots={slots} value={draft.output?.filenamePrefix || null} allowUnused={false}
                onChange={(v) => setDraft((d) => ({ ...d, output: { ...(d.output || {}), filenamePrefix: v } }))}
                filter={(s) => /filename_prefix$/.test(s.address)} /></div>
            <div className="field-block"><span className="field-label">format (optional)</span>
              <SlotSelect slots={slots} value={draft.output?.format || null}
                onChange={(v) => setDraft((d) => ({ ...d, output: { ...(d.output || {}), format: v } }))}
                filter={(s) => /\.format$/.test(s.address)} /></div>
          </div>

          {(detail.notes || []).length ? (
            <details>
              <summary>Template notes ({detail.notes.length})</summary>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'pre-wrap', marginTop: 6 }}>
                {detail.notes.map((n, i) => <div key={i} style={{ marginBottom: 8 }}>{typeof n === 'string' ? n : n.text || n.content || JSON.stringify(n)}</div>)}
              </div>
            </details>
          ) : null}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="primary" disabled={saving || !configured || !!builtinInstall} onClick={save}>{saving ? 'Saving…' : detail.existing ? 'Update model' : 'Save model'}</button>
            <button type="button" onClick={() => { setDetail(null); setDraft(null); setSaved(null); }}>Close</button>
            {saved ? <span style={{ color: 'var(--ok)' }}>Saved — "{saved}" is now available in the render dialogs.</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
