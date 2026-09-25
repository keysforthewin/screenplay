import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPutJson } from '../api.js';

// Admin page → Models: which Claude model each backend feature calls.
//
// One dropdown per slot from GET /api/admin/models. "Default" means the slot
// has no override and follows its env var (ANTHROPIC_MODEL & co.); picking a
// model stores an override that takes effect on the very next call — no
// restart. Saves send only the slots the admin changed (partial merge).
const DEFAULT = '';

export function ModelSlotsPanel() {
  const [data, setData] = useState(null); // { slots, catalog, live_catalog, updated_* }
  const [draft, setDraft] = useState({}); // key → override id ('' = default)
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/admin/models');
        if (cancelled) return;
        setData(r);
        setDraft(Object.fromEntries((r.slots || []).map((s) => [s.key, s.override || DEFAULT])));
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dirtyKeys = useMemo(() => {
    if (!data) return [];
    return data.slots.filter((s) => (s.override || DEFAULT) !== (draft[s.key] ?? DEFAULT)).map((s) => s.key);
  }, [data, draft]);

  // A stored id that isn't in the catalog (typed in, or a model that fell out
  // of the live list) still needs an <option> so the select shows it.
  function optionsFor(slot) {
    const list = [...(data?.catalog || [])];
    const current = draft[slot.key];
    if (current && !list.some((m) => m.id === current)) list.push({ id: current, label: `${current} (not in catalog)` });
    return list;
  }

  function change(key, value) {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save() {
    if (!data || busy || !dirtyKeys.length) return;
    setBusy(true);
    setError(null);
    try {
      const slots = Object.fromEntries(dirtyKeys.map((k) => [k, draft[k] || null]));
      const r = await apiPutJson('/admin/models', { slots });
      setData((prev) => ({ ...prev, ...r }));
      setDraft(Object.fromEntries((r.slots || []).map((s) => [s.key, s.override || DEFAULT])));
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function resetAll() {
    setSaved(false);
    setDraft(Object.fromEntries((data?.slots || []).map((s) => [s.key, DEFAULT])));
  }

  const agent = data?.slots.find((s) => s.key === 'agent');
  const writer = data?.slots.find((s) => s.key === 'writer');
  const effectiveAgent = agent ? (draft.agent || agent.default) : null;
  const effectiveWriter = writer ? (draft.writer || writer.default) : null;
  const twoTier = effectiveAgent && effectiveWriter && effectiveAgent !== effectiveWriter;

  return (
    <section className="model-slots">
      <h2 style={{ marginTop: 0 }}>Models</h2>
      <p style={{ color: 'var(--fg-muted)' }}>
        Which Claude model the backend uses for each feature. Changes apply to the
        next request — no restart. "Default" follows the server's environment
        setting shown beside it.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <p style={{ color: 'var(--fg-muted)' }}>Loading models…</p>}

      {data && (
        <>
          {!data.live_catalog && (
            <p style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
              Could not reach the Anthropic model list — showing the built-in catalog only.
            </p>
          )}
          <div className="model-slots-grid">
            {data.slots.map((slot) => (
              <div key={slot.key} className="field-block model-slot">
                <label className="field-label" htmlFor={`model-slot-${slot.key}`}>{slot.label}</label>
                <select
                  id={`model-slot-${slot.key}`}
                  value={draft[slot.key] ?? DEFAULT}
                  disabled={busy}
                  onChange={(e) => change(slot.key, e.target.value)}
                >
                  <option value={DEFAULT}>Default ({slot.default})</option>
                  {optionsFor(slot).map((m) => (
                    <option key={m.id} value={m.id}>{m.label || m.id}</option>
                  ))}
                </select>
                <p className="field-help">{slot.help}</p>
              </div>
            ))}
          </div>

          <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
            {twoTier
              ? <>Agent and writer differ → <strong>two-tier mode</strong>: the orchestrator delegates creative text to the writer model.</>
              : <>Agent and writer are the same model → <strong>single-model mode</strong>: creative tools run inline, no delegation.</>}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button type="button" className="primary" onClick={save} disabled={busy || !dirtyKeys.length}>
              {busy ? 'Saving…' : dirtyKeys.length ? `Save ${dirtyKeys.length} change${dirtyKeys.length === 1 ? '' : 's'}` : 'Saved'}
            </button>
            <button type="button" onClick={resetAll} disabled={busy}>Reset all to defaults</button>
            {saved && <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Saved — live now.</span>}
          </div>
          {data.updated_by && (
            <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 12 }}>
              Last changed by {data.updated_by}{data.updated_at ? ` on ${new Date(data.updated_at).toLocaleString()}` : ''}
            </p>
          )}
        </>
      )}
    </section>
  );
}
