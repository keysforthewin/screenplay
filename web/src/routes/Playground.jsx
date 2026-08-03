import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPostJson, apiPostMultipart, apiDelete, apiSseUrl, imageUrl, thumbUrl, attachmentUrl } from '../api.js';
import { categoryImplications, defaultFilters, modelMatchesFilters, modelMatchesSearch, modelReadiness } from '../playgroundFilter.js';
import { estimatePlaygroundCost, rowPriceLabel } from '../playgroundCost.js';
import { ElevenLabsPanel } from '../widgets/ElevenLabsPanel.jsx';

// Scratchpad for trying any fal.ai model: drop reference media, type a
// prompt, pick a model (the list live-filters to models that can accept
// everything attached), generate, and the output lands in the results list
// below. Results persist in GridFS (owner_type 'playground') but the list
// itself is session-local.

const MODEL_STORAGE_KEY = 'screenplay.playground.last_model';
const MAX_IMAGES = 8;

const OUTPUT_ICONS = { image: '🖼️', video: '🎬', audio: '🔊' };

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function refGlyph(kind) {
  return kind === 'audio' ? '🔊' : kind === 'video' ? '🎬' : '🖼️';
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function Playground() {
  const [registry, setRegistry] = useState(null);
  const [registryError, setRegistryError] = useState(null);
  const [refs, setRefs] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(() => {
    try { return localStorage.getItem(MODEL_STORAGE_KEY) || null; } catch { return null; }
  });
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState([]);
  const [tab, setTab] = useState('create');
  const [history, setHistory] = useState(null); // null = not loaded yet
  const [historyError, setHistoryError] = useState(null);
  const fileInputRef = useRef(null);
  const esRef = useRef(null);

  // (Re)fetch on every switch to the tab so fresh generations show up.
  useEffect(() => {
    if (tab !== 'history') return undefined;
    let cancelled = false;
    setHistoryError(null);
    (async () => {
      try {
        const r = await apiGet('/playground/history');
        if (!cancelled) setHistory(r.items || []);
      } catch (e) {
        if (!cancelled) setHistoryError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/playground/models');
        if (!cancelled) setRegistry(r);
      } catch (e) {
        if (!cancelled) setRegistryError(e.message);
      }
    })();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, []);

  const counts = useMemo(() => {
    const c = { image: 0, audio: 0, video: 0 };
    for (const r of refs) c[r.kind] += 1;
    return c;
  }, [refs]);
  const hasPrompt = prompt.trim().length > 0;

  // Checkbox filters. The input boxes auto-check/uncheck as the matching
  // input appears/disappears, but only that kind's box moves — a manual
  // toggle survives unrelated changes (prevPresence tracks the transitions).
  const [filterState, setFilterState] = useState(() => defaultFilters());
  const prevPresence = useRef({ prompt: false, image: false, audio: false, video: false });
  useEffect(() => {
    const presence = {
      prompt: hasPrompt,
      image: counts.image > 0,
      audio: counts.audio > 0,
      video: counts.video > 0,
    };
    const changed = Object.keys(presence).filter((k) => presence[k] !== prevPresence.current[k]);
    prevPresence.current = presence;
    if (changed.length) {
      setFilterState((prev) => {
        const next = { ...prev };
        for (const k of changed) next[k] = presence[k];
        return next;
      });
    }
  }, [hasPrompt, counts]);
  const visible = useMemo(() => {
    const models = registry?.models || [];
    const filters = { ...filterState, imageCount: counts.image };
    return models
      .filter((m) => modelMatchesFilters(m, filters))
      .filter((m) => modelMatchesSearch(m, search))
      .sort((a, b) => (a.category || '').localeCompare(b.category || '')
        || (a.display_name || '').localeCompare(b.display_name || ''));
  }, [registry, filterState, counts.image, search]);

  // Distinct categories present in the catalog, with model counts, for the
  // category dropdown. Data-driven — new categories appear automatically.
  const categories = useMemo(() => {
    const tally = new Map();
    for (const m of registry?.models || []) {
      const c = m.category || '';
      if (!c) continue;
      tally.set(c, (tally.get(c) || 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [registry]);

  // Drop the selection when the chosen model filters out.
  useEffect(() => {
    if (selectedId && !visible.some((m) => m.endpoint_id === selectedId)) {
      setSelectedId(null);
    }
  }, [visible, selectedId]);

  const selected = visible.find((m) => m.endpoint_id === selectedId) || null;
  const readiness = selected ? modelReadiness(selected, counts, hasPrompt) : { ready: false, missing: [] };

  // Output controls (size / resolution / duration) for the selected model.
  // Reset to the model's schema defaults whenever the selection changes.
  const [optionSel, setOptionSel] = useState({});
  useEffect(() => {
    const next = {};
    for (const c of selected?.controls || []) {
      if (c.default !== null && c.default !== undefined) next[c.name] = c.default;
    }
    setOptionSel(next);
    // Depends on selectedId only: `selected` gets a new identity on every
    // render, and re-running would stomp the user's in-flight selections.
  }, [selectedId]);

  const costEstimate = selected
    ? estimatePlaygroundCost(selected, { selections: optionSel, promptLength: prompt.trim().length })
    : null;

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError(null);
    setUploading(true);
    const skipped = [];
    try {
      const tally = { ...counts };
      for (const file of files) {
        const kind = file.type.startsWith('image/') ? 'image'
          : file.type.startsWith('audio/') ? 'audio'
          : file.type.startsWith('video/') ? 'video'
          : null;
        if (!kind) { skipped.push(`${file.name} (unsupported type)`); continue; }
        if (kind === 'image' && tally.image >= MAX_IMAGES) { skipped.push(`${file.name} (max ${MAX_IMAGES} images)`); continue; }
        if (kind !== 'image' && tally[kind] >= 1) { skipped.push(`${file.name} (one ${kind} file max)`); continue; }
        const fd = new FormData();
        fd.append('file', file);
        const r = await apiPostMultipart('/playground/upload', fd);
        tally[kind] += 1;
        setRefs((prev) => [...prev, r.ref]);
      }
      if (skipped.length) setError(`Skipped: ${skipped.join(', ')}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  async function removeRef(ref) {
    setRefs((prev) => prev.filter((r) => r.file_id !== ref.file_id));
    try {
      await apiDelete(`/playground/ref/${ref.kind}/${ref.file_id}`);
    } catch {
      // Best-effort cleanup; the file is orphaned server-side at worst.
    }
  }

  function closeStream() {
    esRef.current?.close();
    esRef.current = null;
  }

  async function generate() {
    if (!selected || !readiness.ready || generating) return;
    setError(null);
    setJob(null);
    setGenerating(true);
    try {
      const r = await apiPostJson('/playground/generate', {
        model_id: selected.endpoint_id,
        prompt: prompt.trim() || null,
        refs: refs.map(({ file_id, kind }) => ({ file_id, kind })),
        options: optionSel,
      });
      const jobId = r?.job_id;
      if (!jobId) {
        setGenerating(false);
        setError('Server did not return a job id.');
        return;
      }
      try { localStorage.setItem(MODEL_STORAGE_KEY, selected.endpoint_id); } catch { /* ignore */ }
      const modelLabel = selected.display_name || selected.endpoint_id;
      const promptAtSubmit = prompt.trim();
      const es = new EventSource(apiSseUrl(`/playground/job/${jobId}/events`));
      esRef.current = es;
      es.addEventListener('snapshot', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('update', (ev) => setJob(safeParse(ev.data)));
      es.addEventListener('done', (ev) => {
        const snap = safeParse(ev.data);
        setJob(snap);
        setGenerating(false);
        closeStream();
        const outputs = snap?.outputs || [];
        setResults((prev) => [
          ...outputs.map((o) => ({ ...o, model: modelLabel, prompt: promptAtSubmit, at: Date.now() })),
          ...prev,
        ]);
      });
      es.addEventListener('error', (ev) => {
        // Server-emitted 'error' event carries data; a bare SSE disconnect
        // does not. Same disambiguation as GenerateVideoDialog.
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

  const generateTooltip = !selected
    ? 'Pick a model from the list.'
    : readiness.missing.length
    ? `Need: ${readiness.missing.join(', ')}`
    : '';

  return (
    <main className="app playground">
      <h1>Playground</h1>
      <p className="playground-intro">
        Try any fal.ai model: drop reference media, add a prompt, pick a model, generate.
      </p>

      {registryError && <div className="error-banner">{registryError}</div>}
      {registry?.catalog_error && <div className="error-banner">{registry.catalog_error}</div>}
      {registry && !registry.configured && (
        <div className="error-banner">fal.ai is not configured on the server (FAL_KEY missing) — generation is disabled.</div>
      )}
      {error && <div className="error-banner">{error}</div>}

      <div className="tab-nav" role="tablist">
        {[['create', 'Create'], ['elevenlabs', 'ElevenLabs'], ['history', 'History']].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab-button${tab === id ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'history' && (
        <div className="playground-results playground-history">
          {historyError && <div className="error-banner">{historyError}</div>}
          {!history && !historyError && <p className="playground-empty">Loading history…</p>}
          {history && history.length === 0 && (
            <p className="playground-empty">No generations yet in this project.</p>
          )}
          {(history || []).map((r) => (
            <div key={r.file_id} className="playground-result">
              {r.kind === 'image' && (
                <a href={imageUrl(r.file_id)} target="_blank" rel="noreferrer">
                  <img src={thumbUrl(r.file_id)} alt={r.prompt || 'generated image'} />
                </a>
              )}
              {r.kind === 'video' && (
                <video controls src={attachmentUrl(r.file_id)} preload="metadata" playsInline />
              )}
              {r.kind === 'audio' && (
                <audio controls src={attachmentUrl(r.file_id)} preload="metadata" />
              )}
              <div className="playground-result-meta">
                {r.model && <span className="playground-result-model">{r.model}</span>}
                {r.prompt && <span className="playground-result-prompt">{r.prompt}</span>}
                {r.created_at && (
                  <span className="playground-result-date">
                    {new Date(r.created_at).toLocaleString()}
                  </span>
                )}
                <a
                  href={r.kind === 'image' ? imageUrl(r.file_id) : attachmentUrl(r.file_id)}
                  download
                >
                  Download
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'elevenlabs' && <ElevenLabsPanel />}

      {tab === 'create' && (<>
      <div
        className={'ref-picker-drop playground-drop' + (dragging ? ' is-dragging' : '')}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer?.files);
        }}
      >
        <p>Drop images, audio, or video here to use as references, or</p>
        <button
          type="button"
          className="primary"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? 'Uploading…' : 'Choose files'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,audio/*,video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {refs.length > 0 && (
        <div className="playground-chips">
          {refs.map((r) => (
            <span key={r.file_id} className="playground-chip" title={`${r.filename} — ${formatBytes(r.size)}`}>
              {r.kind === 'image'
                ? <img src={thumbUrl(r.file_id)} alt={r.filename} />
                : <span className="playground-chip-glyph">{refGlyph(r.kind)}</span>}
              <span className="playground-chip-name">{r.filename}</span>
              <button type="button" title="Remove" onClick={() => removeRef(r)}>×</button>
            </span>
          ))}
        </div>
      )}

      <label className="field-label" htmlFor="playground-prompt">Prompt</label>
      <textarea
        id="playground-prompt"
        rows={4}
        value={prompt}
        placeholder="Describe what to generate (leave empty for prompt-less models like upscalers)"
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className="playground-model-head">
        <label className="field-label">
          Model
          {registry && (
            <span className="playground-model-count">
              {' '}— {visible.length} of {registry.models?.length ?? 0} match
              {registry.catalog_generated_at ? ` (list from ${String(registry.catalog_generated_at).slice(0, 10)})` : ''}
            </span>
          )}
        </label>
        <input
          type="search"
          placeholder="Search models…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="playground-filters">
        <span className="playground-filter-group">
          <span className="playground-filter-label">Inputs</span>
          {['prompt', 'image', 'audio', 'video'].map((k) => (
            <label key={k} className="playground-filter-check">
              <input
                type="checkbox"
                checked={filterState[k]}
                onChange={(e) => setFilterState((prev) => ({ ...prev, [k]: e.target.checked }))}
              />
              {k}
            </label>
          ))}
        </span>
        <span className="playground-filter-group">
          <span className="playground-filter-label">Category</span>
          <select
            className="playground-filter-category"
            value={filterState.category || ''}
            onChange={(e) => {
              const category = e.target.value || null;
              // A '<input>-to-<output>' category presets the input checkboxes
              // and the output kind so its models actually match the filters.
              const implied = categoryImplications(category);
              setFilterState((prev) => (implied
                ? { ...prev, category, ...implied.inputs, output: implied.output }
                : { ...prev, category }));
            }}
          >
            <option value="">all categories</option>
            {categories.map(([c, n]) => (
              <option key={c} value={c}>{c} ({n})</option>
            ))}
          </select>
        </span>
        <span className="playground-filter-group">
          <span className="playground-filter-label">Output</span>
          <select
            className="playground-filter-output"
            value={filterState.output || ''}
            onChange={(e) => setFilterState((prev) => ({ ...prev, output: e.target.value || null }))}
          >
            <option value="">any output</option>
            {['image', 'video', 'audio'].map((k) => (
              <option key={k} value={k}>{OUTPUT_ICONS[k]} {k}</option>
            ))}
          </select>
        </span>
      </div>

      <div className="playground-model-list">
        {!registry && !registryError && <p className="playground-empty">Loading models…</p>}
        {registry && visible.length === 0 && (
          <p className="playground-empty">
            No models match these filters — attach media, type a prompt, or adjust the checkboxes above.
          </p>
        )}
        {visible.map((m) => {
          const r = modelReadiness(m, counts, hasPrompt);
          return (
            <label
              key={m.endpoint_id}
              className={
                'playground-model-row'
                + (m.endpoint_id === selectedId ? ' is-selected' : '')
              }
              title={[m.description, m.price_text].filter(Boolean).join('\n\n') || undefined}
            >
              <input
                type="radio"
                name="playground-model"
                checked={m.endpoint_id === selectedId}
                onChange={() => setSelectedId(m.endpoint_id)}
              />
              <span className="playground-model-icon">{OUTPUT_ICONS[m.output?.kind] || '📄'}</span>
              <span className="playground-model-name">
                {m.display_name}
                <span className="playground-model-id">{m.endpoint_id}</span>
                {m.description && (
                  <span className="playground-model-desc">{m.description}</span>
                )}
              </span>
              <span className="playground-model-badge">{m.category || m.output?.kind}</span>
              {!r.ready && (
                <span className="playground-model-missing">needs {r.missing.join(', ')}</span>
              )}
              <span className="playground-model-cost">{rowPriceLabel(m)}</span>
            </label>
          );
        })}
      </div>

      {selected && (selected.controls?.length ?? 0) > 0 && (
        <div className="playground-controls">
          {selected.controls.map((c) => (
            <label key={c.name} className="playground-control">
              <span className="playground-control-name">{c.name.replace(/_/g, ' ')}</span>
              {c.type === 'enum' ? (
                <select
                  value={optionSel[c.name] ?? ''}
                  onChange={(e) => setOptionSel((prev) => ({ ...prev, [c.name]: e.target.value }))}
                >
                  {(c.default === null || c.default === undefined) && (
                    <option value="">(model default)</option>
                  )}
                  {c.options.map((o) => (
                    <option key={String(o)} value={o}>{String(o)}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="number"
                  value={optionSel[c.name] ?? ''}
                  min={c.min ?? undefined}
                  max={c.max ?? undefined}
                  placeholder={c.default != null ? String(c.default) : ''}
                  onChange={(e) => setOptionSel((prev) => {
                    const next = { ...prev };
                    if (e.target.value === '') delete next[c.name];
                    else next[c.name] = e.target.value;
                    return next;
                  })}
                />
              )}
            </label>
          ))}
        </div>
      )}

      <div className="playground-generate-row">
        <button
          type="button"
          className="primary"
          disabled={!selected || !readiness.ready || generating || !registry?.configured}
          title={generateTooltip}
          onClick={generate}
        >
          {generating ? 'Generating…' : 'Generate'}
        </button>
        {selected && (
          <span
            className="playground-cost-estimate"
            title={costEstimate?.basis ? `Basis: ${costEstimate.basis}` : (selected.price_text || undefined)}
          >
            {costEstimate?.label
              ? `${costEstimate.exact ? 'Cost' : 'Est. cost'}: ${costEstimate.label}`
              : rowPriceLabel(selected)}
          </span>
        )}
        {job && job.status !== 'done' && (
          <span className="playground-job-status">
            {job.step || job.status}
            {job.queue_position != null && job.queue_position > 0 ? ` (queue ${job.queue_position})` : ''}
          </span>
        )}
        {generating && job?.logs?.length > 0 && (
          <span className="playground-job-log">{job.logs[job.logs.length - 1].message}</span>
        )}
      </div>

      {results.length > 0 && (
        <div className="playground-results">
          <h2>Results</h2>
          {results.map((r) => (
            <div key={r.file_id} className="playground-result">
              {r.kind === 'image' && (
                <a href={imageUrl(r.file_id)} target="_blank" rel="noreferrer">
                  <img src={thumbUrl(r.file_id)} alt={r.prompt || 'generated image'} />
                </a>
              )}
              {r.kind === 'video' && (
                <video controls src={attachmentUrl(r.file_id)} preload="metadata" playsInline />
              )}
              {r.kind === 'audio' && (
                <audio controls src={attachmentUrl(r.file_id)} preload="metadata" />
              )}
              <div className="playground-result-meta">
                <span className="playground-result-model">{r.model}</span>
                {r.prompt && <span className="playground-result-prompt">{r.prompt}</span>}
                <a
                  href={r.kind === 'image' ? imageUrl(r.file_id) : attachmentUrl(r.file_id)}
                  download
                >
                  Download
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
      </>)}
    </main>
  );
}
