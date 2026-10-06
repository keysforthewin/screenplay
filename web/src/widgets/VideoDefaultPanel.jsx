// Admin page → Video renderer: the provider + model every cut video is
// rendered with when nothing picks one — the Scenes-tab dialogs preselect
// it, and the REST routes and the MCP `render_videos` tool (what a coding
// agent or the storyboard skill calls) fall back to it. Stored app-wide in
// app_settings {_id:'video_default'}; GET/PUT /api/admin/video-default.
import { useEffect, useState } from 'react';
import { apiGet, apiPutJson } from '../api.js';

function parseError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

export function VideoDefaultPanel() {
  const [data, setData] = useState(null); // { default, comfy_models, fal_models }
  const [provider, setProvider] = useState('comfy');
  const [modelId, setModelId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/admin/video-default');
        if (cancelled) return;
        setData(r);
        if (r.default?.model_id) {
          setProvider(r.default.provider);
          setModelId(r.default.model_id);
        }
      } catch (e) {
        if (!cancelled) setError(parseError(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const models = provider === 'fal' ? data?.fal_models || [] : data?.comfy_models || [];
  const stored = data?.default || null;
  const dirty = (stored?.model_id || '') !== modelId || (modelId && stored?.provider !== provider);

  async function put(body) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await apiPutJson('/admin/video-default', body);
      setData((prev) => ({ ...prev, default: r.default }));
      if (r.default?.model_id) {
        setProvider(r.default.provider);
        setModelId(r.default.model_id);
      } else {
        setModelId('');
      }
      setSaved(true);
    } catch (e) {
      setError(parseError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="video-default-panel">
      <h2 style={{ marginTop: 40 }}>Video renderer</h2>
      <p style={{ color: 'var(--fg-muted)' }}>
        The model every cut video is rendered with unless someone picks another one: the Scenes tab&apos;s
        Generate video dialogs start on it, and anything that renders without naming a model — the
        MCP <code>render_videos</code> tool a coding agent or the storyboard skill calls, a REST call
        without <code>model_id</code> — uses it. With no default those calls are refused.
      </p>
      {!data && !error ? <p style={{ color: 'var(--fg-muted)' }}>Loading…</p> : null}
      {data ? (
        <div style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name="video-default-provider" value="comfy" checked={provider === 'comfy'} onChange={() => { setProvider('comfy'); setModelId(''); }} />
              ComfyUI
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name="video-default-provider" value="fal" checked={provider === 'fal'} onChange={() => { setProvider('fal'); setModelId(''); }} />
              fal.ai
            </label>
          </div>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={busy} style={{ maxWidth: 520 }}>
            <option value="">— no default —</option>
            {modelId && !models.some((m) => m.id === modelId) ? <option value={modelId}>{modelId} (not in this list)</option> : null}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}{m.builtin === false ? ' · registered from the gallery' : ''}</option>
            ))}
          </select>
          {provider === 'fal' && !models.length ? (
            <p className="field-help">No fal.ai models listed — fal.ai is not configured here, or its catalog has not been loaded.</p>
          ) : null}
          {stored?.model_id ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>
              Current default: <strong>{stored.label || stored.model_id}</strong> ({stored.provider === 'fal' ? 'fal.ai' : 'ComfyUI'})
              {stored.known === false ? ' — no longer in the ComfyUI registry; renders with it will fail.' : ''}
              {stored.updated_by ? ` · set by ${stored.updated_by}` : ''}
            </p>
          ) : (
            <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>No default set.</p>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="primary" disabled={busy || !dirty || !modelId} onClick={() => put({ provider, model_id: modelId })}>
              Save default
            </button>
            <button type="button" disabled={busy || !stored?.model_id} onClick={() => put({ model_id: null })}>Clear</button>
            {saved ? <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Saved.</span> : null}
          </div>
        </div>
      ) : null}
      {error ? <p style={{ color: 'var(--danger, #c33)' }}>{error}</p> : null}
    </section>
  );
}
