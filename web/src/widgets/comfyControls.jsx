// Small ComfyUI model-picker pieces shared by ComfyVideoDialog (one cut) and
// RenderCutsDialog (the whole beat), plus a once-per-page availability probe.
import { useEffect, useState } from 'react';
import { apiGet } from '../api.js';

// GET /comfy/models once per page load (module cache); every cut row reads
// the same answer to label its ComfyUI button. { configured, reason, models }.
let availabilityPromise = null;
export function loadComfyAvailability() {
  if (!availabilityPromise) {
    availabilityPromise = apiGet('/comfy/models').catch(() => ({ configured: false, reason: COMFY_DISABLED_MESSAGE, models: [] }));
  }
  return availabilityPromise;
}
export function resetComfyAvailabilityForTests() {
  availabilityPromise = null;
}
export function useComfyAvailability() {
  const [state, setState] = useState(null);
  useEffect(() => {
    let cancelled = false;
    loadComfyAvailability().then((r) => { if (!cancelled) setState(r); });
    return () => { cancelled = true; };
  }, []);
  return state; // null while loading
}

export function ModelGroup({ title, models, selected, onPick, disabled }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '.04em', margin: '6px 0 2px' }}>
        {title}
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 4 }}>
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={disabled || !m.available}
            onClick={() => onPick(m.id)}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 10px',
              background: selected === m.id ? 'rgba(122, 166, 255, 0.10)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--border)',
              textAlign: 'left',
              cursor: disabled ? 'default' : 'pointer',
              color: 'var(--fg)',
              opacity: m.available ? 1 : 0.6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{m.label}</span>
              <Badge ok={!m.spends_credits}>{m.spends_credits ? 'Credits' : 'Free'}</Badge>
              {!m.verified ? <Badge>Untested</Badge> : null}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 3, fontSize: 11, color: 'var(--fg-muted)' }}>
              {m.lab ? <span>{m.lab}</span> : null}
              {m.inputs?.startFrame === 'required' ? <span>needs start frame</span> : null}
              {m.inputs?.audio === 'required' ? <span>lip-sync (needs recorded dialogue)</span> : null}
              {m.inputs?.referenceImages && m.inputs.referenceImages !== 'unused' ? (
                <span>references{m.max_reference_images ? ` ×${m.max_reference_images}` : ''}</span>
              ) : null}
              <span style={{ fontFamily: 'monospace' }}>{m.template}</span>
            </div>
            {selected === m.id && m.description ? (
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>{m.description}</div>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Badge({ ok, children }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 3,
        background: ok ? 'rgba(106, 207, 126, 0.15)' : 'rgba(138, 143, 163, 0.15)',
        color: ok ? 'var(--ok)' : 'var(--fg-muted)',
        border: `1px solid ${ok ? 'var(--ok)' : 'var(--border)'}`,
      }}
    >
      {children}
    </span>
  );
}

// A compact <select> over the registry for a dialog that picks models by
// role (clip / lip-sync) rather than browsing them.
export function ComfyModelSelect({ models, value, onChange, filter, placeholder = 'Server default', disabled }) {
  const list = (models || []).filter((m) => m.available !== false && (!filter || filter(m)));
  const local = list.filter((m) => m.kind !== 'api');
  const api = list.filter((m) => m.kind === 'api');
  const opt = (m) => (
    <option key={m.id} value={m.id}>
      {m.label}{m.spends_credits ? ' (credits)' : ''}{m.verified === false ? ' · untested' : ''}
    </option>
  );
  return (
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} style={{ width: '100%' }}>
      <option value="">{placeholder}</option>
      {local.length ? <optgroup label="Local (free, your GPU)">{local.map(opt)}</optgroup> : null}
      {api.length ? <optgroup label="API (spends Comfy credits)">{api.map(opt)}</optgroup> : null}
    </select>
  );
}

export const COMFY_DISABLED_MESSAGE = 'ComfyUI rendering is disabled on this server.';
