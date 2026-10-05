import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPutJson } from '../api.js';

// Admin page → Models: which Claude model each backend feature calls.
//
// One row per slot from GET /api/admin/models. "Default" means the slot has
// no override and follows its env var (ANTHROPIC_MODEL & co.); picking a model
// stores an override that takes effect on the very next call — no restart.
// Saves send only the slots the admin changed (partial merge).
//
// Provider: the Anthropic API, or (dev only, LLM_HARNESS_ENABLED) a local
// coding agent — Claude Code or Codex — with a model picked from that
// provider's list ("host default model" = the host's configured default) and
// an effort level.
const DEFAULT = '';
const API = 'api';

// Stored override → editable draft row.
function draftFromSlot(slot) {
  const o = slot.override;
  if (o && typeof o === 'object') {
    return { provider: o.provider, api: DEFAULT, model: o.model || '', effort: o.effort || '' };
  }
  return { provider: API, api: o || DEFAULT, model: '', effort: '' };
}

// Draft row → the PUT value (null = back to the env default).
function overrideFromDraft(d) {
  if (!d) return null;
  if (d.provider === API) return d.api || null;
  return { provider: d.provider, model: d.model.trim() || null, effort: d.effort || null };
}

const sameOverride = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function ModelSlotsPanel() {
  const [data, setData] = useState(null); // { slots, catalog, live_catalog, updated_* }
  const [draft, setDraft] = useState({}); // key → { provider, api, model, effort }
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
        setDraft(Object.fromEntries((r.slots || []).map((s) => [s.key, draftFromSlot(s)])));
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dirtyKeys = useMemo(() => {
    if (!data) return [];
    return data.slots
      .filter((s) => !sameOverride(overrideFromDraft(draftFromSlot(s)), overrideFromDraft(draft[s.key])))
      .map((s) => s.key);
  }, [data, draft]);

  // A stored id that isn't in the catalog (typed in, or a model that fell out
  // of the live list) still needs an <option> so the select shows it.
  function optionsFor(slot) {
    const list = [...(data?.catalog || [])];
    const current = draft[slot.key]?.api;
    if (current && !list.some((m) => m.id === current)) list.push({ id: current, label: `${current} (not in catalog)` });
    return list;
  }

  function change(key, patch) {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  }

  // Switching provider drops a model or effort the new provider does not have
  // (a Codex model left on a Claude Code slot fails every call).
  function changeProvider(key, provider) {
    const p = providerDef(provider);
    const cur = draft[key] || {};
    const model = p?.models?.some((m) => m.id === cur.model) ? cur.model : '';
    const efforts = p?.models?.find((m) => m.id === model)?.efforts || p?.efforts || [];
    change(key, { provider, model, effort: efforts.includes(cur.effort) ? cur.effort : '' });
  }

  // The provider's models, plus the stored one when the list does not have it.
  function harnessModelsFor(d) {
    const list = [...(providerDef(d.provider)?.models || [])];
    if (d.model && !list.some((m) => m.id === d.model)) list.push({ id: d.model, label: `${d.model} (not in list)` });
    return list;
  }

  const providers = data?.harness?.providers || [];
  const harnessEnabled = !!data?.harness?.enabled;
  const providerDef = (id) => providers.find((p) => p.id === id);
  // Effort levels for the typed model when the catalog knows it, else the provider's.
  function effortsFor(d) {
    const p = providerDef(d.provider);
    const m = p?.models?.find((x) => x.id === d.model.trim());
    return m?.efforts?.length ? m.efforts : p?.efforts || [];
  }

  async function save() {
    if (!data || busy || !dirtyKeys.length) return;
    setBusy(true);
    setError(null);
    try {
      const slots = Object.fromEntries(dirtyKeys.map((k) => [k, overrideFromDraft(draft[k])]));
      const r = await apiPutJson('/admin/models', { slots });
      setData((prev) => ({ ...prev, ...r }));
      setDraft(Object.fromEntries((r.slots || []).map((s) => [s.key, draftFromSlot(s)])));
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function resetAll() {
    setSaved(false);
    setDraft(Object.fromEntries((data?.slots || []).map((s) => [s.key, draftFromSlot({ override: null })])));
  }

  const agent = data?.slots.find((s) => s.key === 'agent');
  const writer = data?.slots.find((s) => s.key === 'writer');
  // Mirrors the server's encoding so the two-tier hint matches modelFor().
  const effectiveOf = (slot) => {
    const o = overrideFromDraft(draft[slot.key]);
    if (!o) return slot.default;
    return typeof o === 'string' ? o : `${o.provider}:${o.model || 'default'}:${o.effort || 'default'}`;
  };
  const effectiveAgent = agent ? effectiveOf(agent) : null;
  const effectiveWriter = writer ? effectiveOf(writer) : null;
  const twoTier = effectiveAgent && effectiveWriter && effectiveAgent !== effectiveWriter;

  return (
    <section className="model-slots">
      <h2 style={{ marginTop: 0 }}>Models</h2>
      <p style={{ color: 'var(--fg-muted)' }}>
        Which Claude model the backend uses for each feature. Changes apply to the
        next request — no restart. "Default" follows the server's environment
        setting shown beside it.
      </p>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
        {harnessEnabled
          ? <>Coding agents are enabled here: a slot can run through the host's logged-in <strong>Claude Code</strong> or <strong>Codex</strong> (their login, skills and config) instead of the API. Blank model / effort = the agent's own default.</>
          : <>Coding-agent providers (Claude Code / Codex) are disabled on this server — they are a dev-only option (<code>LLM_HARNESS_ENABLED</code>).</>}
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
                <div className="model-slot-row">
                  <select
                    aria-label={`${slot.label} provider`}
                    value={draft[slot.key]?.provider || API}
                    disabled={busy}
                    onChange={(e) => changeProvider(slot.key, e.target.value)}
                  >
                    <option value={API}>Anthropic API</option>
                    {providers.map((p) => (
                      <option
                        key={p.id}
                        value={p.id}
                        disabled={!harnessEnabled && draft[slot.key]?.provider !== p.id}
                      >
                        {p.label}{harnessEnabled ? '' : ' (disabled on this server)'}
                      </option>
                    ))}
                  </select>
                  {(draft[slot.key]?.provider || API) === API ? (
                    <select
                      id={`model-slot-${slot.key}`}
                      value={draft[slot.key]?.api ?? DEFAULT}
                      disabled={busy}
                      onChange={(e) => change(slot.key, { api: e.target.value })}
                    >
                      <option value={DEFAULT}>Default ({slot.default})</option>
                      {optionsFor(slot).map((m) => (
                        <option key={m.id} value={m.id}>{m.label || m.id}</option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <select
                        id={`model-slot-${slot.key}`}
                        value={draft[slot.key].model}
                        disabled={busy}
                        onChange={(e) => change(slot.key, { model: e.target.value })}
                      >
                        <option value="">host default model</option>
                        {harnessModelsFor(draft[slot.key]).map((m) => (
                          <option key={m.id} value={m.id}>{m.label || m.id}</option>
                        ))}
                      </select>
                      <select
                        aria-label={`${slot.label} effort`}
                        value={draft[slot.key].effort}
                        disabled={busy}
                        onChange={(e) => change(slot.key, { effort: e.target.value })}
                      >
                        <option value="">default effort</option>
                        {effortsFor(draft[slot.key]).map((x) => (
                          <option key={x} value={x}>{x}</option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
                {draft[slot.key]?.provider && draft[slot.key].provider !== API && !harnessEnabled && (
                  <p className="field-help" style={{ color: 'var(--danger, #c33)' }}>
                    Stored, but ignored here: this server has coding agents disabled, so the slot uses its API default.
                  </p>
                )}
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
