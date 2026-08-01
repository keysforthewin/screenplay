import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPostJson, apiPostMultipart, apiDelete, apiSseUrl, imageUrl, thumbUrl, attachmentUrl } from '../api.js';
import { modelAcceptsAttachments, modelReadiness } from '../playgroundFilter.js';

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

function costLabel(m) {
  if (!Number.isFinite(m.price_min_usd)) return 'pricing varies';
  const v = m.price_min_usd;
  return `from $${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
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
  const fileInputRef = useRef(null);
  const esRef = useRef(null);

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

  const visible = useMemo(() => {
    const models = registry?.models || [];
    const q = search.trim().toLowerCase();
    return models
      .filter((m) => modelAcceptsAttachments(m, counts, hasPrompt))
      .filter((m) => !q
        || m.endpoint_id.toLowerCase().includes(q)
        || (m.display_name || '').toLowerCase().includes(q)
        || (m.category || '').toLowerCase().includes(q))
      .sort((a, b) => (a.category || '').localeCompare(b.category || '')
        || (a.display_name || '').localeCompare(b.display_name || ''));
  }, [registry, counts, hasPrompt, search]);

  // Drop the selection when the chosen model filters out.
  useEffect(() => {
    if (selectedId && !visible.some((m) => m.endpoint_id === selectedId)) {
      setSelectedId(null);
    }
  }, [visible, selectedId]);

  const selected = visible.find((m) => m.endpoint_id === selectedId) || null;
  const readiness = selected ? modelReadiness(selected, counts, hasPrompt) : { ready: false, missing: [] };

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

      <div className="playground-model-list">
        {!registry && !registryError && <p className="playground-empty">Loading models…</p>}
        {registry && visible.length === 0 && (
          <p className="playground-empty">No models can take this combination of inputs.</p>
        )}
        {visible.map((m) => {
          const r = modelReadiness(m, counts, hasPrompt);
          return (
            <label
              key={m.endpoint_id}
              className={
                'playground-model-row'
                + (m.endpoint_id === selectedId ? ' is-selected' : '')
                + (r.ready ? '' : ' is-not-ready')
              }
              title={m.price_text || undefined}
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
              </span>
              <span className="playground-model-badge">{m.category || m.output?.kind}</span>
              {!r.ready && (
                <span className="playground-model-missing">needs {r.missing.join(', ')}</span>
              )}
              <span className="playground-model-cost">{costLabel(m)}</span>
            </label>
          );
        })}
      </div>

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
    </main>
  );
}
