import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostJson, apiSseUrl } from '../api.js';
import { VideoProgressBar } from './VideoProgressBar.jsx';

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

// "Generate video…" dialog opened from the storyboard scene's AudioSlot.
// Lets the user filter the fal.ai i2v catalog (data/fal-models.json) by the
// input modalities the scene provides, pick a model, then POSTs the request
// and opens an EventSource on the matching job stream so the progress bar
// updates as fal's queue position changes. The fal task continues server-
// side even if the user closes the dialog — when the storyboard's
// video_file_id lands the inline player will appear automatically via the
// room's fields_updated ping.
export function GenerateVideoDialog({ open, onClose, storyboardId, sb, onRefresh }) {
  const [registry, setRegistry] = useState(null); // { default_model_id, configured, catalog_generated_at, catalog_error, models: [...] }
  const [registryError, setRegistryError] = useState(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState(null); // endpoint_id of the chosen catalog row
  const [activeFacets, setActiveFacets] = useState({ ...EMPTY_FACETS });
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(null);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
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
    setActiveFacets({ ...EMPTY_FACETS });
    setPrompt(typeof sb?.text_prompt === 'string' ? sb.text_prompt : '');
    if (registry) {
      const defaultRow = registry.models.find(
        (m) => m.is_registered && m.id === registry.default_model_id,
      ) || registry.models.find((m) => m.is_registered) || null;
      setSelectedEndpoint(defaultRow?.endpoint_id || null);
    }
  }, [open, sb?._id, registry]);

  // When the chosen model changes, snap duration to that model's default
  // (or to the storyboard's duration_seconds, clamped to allowed values).
  useEffect(() => {
    if (!chosenModel) return;
    const allowed = (chosenModel.durations || []).map((d) => Number(d)).filter(Number.isFinite);
    if (!allowed.length) {
      setDuration(null);
      return;
    }
    const sbDur = Number(sb?.duration_seconds);
    let candidate = Number.isFinite(sbDur) && sbDur > 0 ? sbDur : Number(chosenModel.default_duration);
    if (!Number.isFinite(candidate)) candidate = allowed[0];
    const closest = allowed.reduce(
      (best, n) => (Math.abs(n - candidate) < Math.abs(best - candidate) ? n : best),
      allowed[0],
    );
    setDuration(closest);
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

  // Capability-combination matrix (distinct bitmaps that actually occur). Sorted by count desc.
  const matrixRows = useMemo(() => {
    if (!registry?.models?.length) return [];
    const groups = new Map();
    for (const m of registry.models) {
      const key = FACETS.map((f) => (m.capabilities?.[f.key] ? '1' : '0')).join('');
      const arr = groups.get(key) || { key, flags: { ...m.capabilities }, count: 0 };
      arr.count += 1;
      groups.set(key, arr);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }, [registry]);

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
  function applyMatrixRow(rowFlags) {
    setActiveFacets({ ...EMPTY_FACETS, ...Object.fromEntries(FACETS.map((f) => [f.key, !!rowFlags[f.key]])) });
  }
  function isMatrixRowActive(rowFlags) {
    return FACETS.every((f) => !!rowFlags[f.key] === !!activeFacets[f.key]);
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
      const body = {
        model_id: chosenModel.id,
        prompt: prompt.trim() || null,
      };
      if (duration != null) body.duration_seconds = duration;
      if (chosenModel.supports_generate_audio) body.generate_audio = generateAudio;
      const r = await apiPostJson(`/storyboard/${storyboardId}/video/generate`, body);
      const jobId = r?.job_id;
      if (!jobId) {
        setGenerating(false);
        setError('Server did not return a job id.');
        return;
      }
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

  const ready = !generating && chosenModel?.is_registered && missing.length === 0;
  const submitTooltip = !chosenModel
    ? 'Pick a model from the list.'
    : !chosenModel.is_registered
    ? 'Preview model — not yet wired up. Add to src/fal/videoModels.js to enable.'
    : missing.length
    ? `Need: ${missing.join(', ')}`
    : '';

  return (
    <Modal
      open={open}
      title="Generate video"
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
            disabled={!ready}
            title={submitTooltip}
            onClick={submit}
          >
            {generating ? 'Generating…' : 'Generate video'}
          </button>
        </>
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
          matrixRows={matrixRows}
          facetCounts={facetCounts}
          visibleModels={visibleModels}
          chosenModel={chosenModel}
          onToggleFacet={toggleFacet}
          onClearFacets={() => setActiveFacets({ ...EMPTY_FACETS })}
          onMatrixRowClick={applyMatrixRow}
          isMatrixRowActive={isMatrixRowActive}
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

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {chosenModel?.durations?.length ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="field-label">Duration</span>
              <select
                value={duration ?? ''}
                disabled={generating}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {chosenModel.durations.map((d) => (
                  <option key={d} value={Number(d)}>
                    {d}s
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
        </div>
      </div>
    </Modal>
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
// ModelPicker: capability matrix + 5 facet checkboxes + filtered model list.
// Stateless — the parent dialog owns selection / facets / registry state.

function ModelPicker({
  registry,
  generating,
  activeFacets,
  matrixRows,
  facetCounts,
  visibleModels,
  chosenModel,
  onToggleFacet,
  onClearFacets,
  onMatrixRowClick,
  isMatrixRowActive,
  onModelClick,
  onRefreshCatalog,
}) {
  // Sort: Ready first, then by price asc (nulls last), then by display_name.
  const sortedModels = useMemo(() => {
    const arr = [...visibleModels];
    arr.sort((a, b) => {
      if (a.is_registered !== b.is_registered) return a.is_registered ? -1 : 1;
      const ap = a.price_min_usd;
      const bp = b.price_min_usd;
      if (ap == null && bp == null) return (a.display_name || '').localeCompare(b.display_name || '');
      if (ap == null) return 1;
      if (bp == null) return -1;
      if (ap !== bp) return ap - bp;
      return (a.display_name || '').localeCompare(b.display_name || '');
    });
    return arr;
  }, [visibleModels]);

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

      {/* Capability combination matrix */}
      <CapabilityMatrix
        rows={matrixRows}
        isActive={isMatrixRowActive}
        onRowClick={onMatrixRowClick}
        disabled={generating}
      />

      {/* Facet checkboxes */}
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

      {/* Filtered list */}
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 4,
          maxHeight: 260,
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
            disabled={generating}
            onClick={() => onModelClick(m)}
          />
        ))}
      </div>
    </div>
  );
}

function CapabilityMatrix({ rows, isActive, onRowClick, disabled }) {
  if (!rows.length) return null;
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg)',
        overflow: 'hidden',
        fontSize: 12,
        fontFamily: 'monospace',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 32px) 1fr 48px',
          alignItems: 'center',
          padding: '6px 10px',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          color: 'var(--fg-muted)',
        }}
      >
        {FACETS.map((f) => (
          <span key={f.key} style={{ textAlign: 'center' }}>{f.short}</span>
        ))}
        <span style={{ paddingLeft: 8 }}>combo</span>
        <span style={{ textAlign: 'right' }}>n</span>
      </div>
      {rows.map((row) => {
        const active = isActive(row.flags);
        return (
          <button
            type="button"
            key={row.key}
            disabled={disabled}
            onClick={() => onRowClick(row.flags)}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 32px) 1fr 48px',
              alignItems: 'center',
              width: '100%',
              padding: '4px 10px',
              background: active ? 'rgba(122, 166, 255, 0.15)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--border)',
              color: 'var(--fg)',
              cursor: disabled ? 'default' : 'pointer',
              fontFamily: 'monospace',
              fontSize: 12,
              textAlign: 'left',
            }}
          >
            {FACETS.map((f) => (
              <span key={f.key} style={{ textAlign: 'center', color: row.flags[f.key] ? 'var(--ok)' : 'var(--fg-muted)' }}>
                {row.flags[f.key] ? '✓' : '·'}
              </span>
            ))}
            <span style={{ paddingLeft: 8, color: 'var(--fg-muted)' }}>
              {FACETS.filter((f) => row.flags[f.key]).map((f) => f.short).join(', ') || '(none)'}
            </span>
            <span style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>{row.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function ModelRow({ model, selected, disabled, onClick }) {
  const ready = !!model.is_registered;
  const priceLabel = model.price_min_usd != null ? `from $${formatUsd(model.price_min_usd)}` : null;
  const maxLabel = typeof model.max_seconds === 'number' ? `max ${model.max_seconds}s` : null;
  const resBadges = (model.resolutions || []).slice(0, 4);
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

function formatUsd(n) {
  if (n == null) return '—';
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
