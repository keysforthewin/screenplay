import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';
import {
  IMAGE_MODEL_SORTS,
  DEFAULT_IMAGE_MODEL_SORT,
  isImageModelSort,
  sortImageModels,
} from './imageModelSort.js';

const SORT_STORAGE_KEY = 'screenplay.picker.modelSort';

function readStoredSort() {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    return isImageModelSort(v) ? v : DEFAULT_IMAGE_MODEL_SORT;
  } catch {
    return DEFAULT_IMAGE_MODEL_SORT;
  }
}

// Searchable image-model picker backed by the live fal.ai catalog
// (GET /api/image-models → `catalog`), rather than a hand-maintained list that
// goes stale. Shows lab, category, per-image price, and whether the model can
// take reference images. The seven models with tuned pipelines sort first and
// are marked "tuned"; everything else runs through the generic catalog runner.
//
// Props:
//   value        — currently selected model id
//   onChange(id) — called with the new id
//   disabled     — freeze interaction while a generation is running
//   compact      — render a shorter list box (used inside crowded dialogs)
//   requireReferences — restrict the list to models that accept reference
//     images (edit flows anchor on an existing image; a prompt-only model
//     would silently ignore it). Hides the "Takes references" toggle.
//   promptOnly — restrict the list to models that can generate WITHOUT an
//     input image (a requires-references model given none is a provider 422).
//     Also hides the "Takes references" toggle — whether the shot takes
//     references is decided by the flow, not a browsing preference.
export function ImageModelSelect({ value, onChange, disabled = false, compact = false, requireReferences = false, promptOnly = false }) {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [refsOnly, setRefsOnly] = useState(false);
  const [sort, setSort] = useState(readStoredSort);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState(null);
  const pollRef = useRef(null);

  async function load() {
    try {
      const data = await apiGet('/image-models');
      setCatalog(Array.isArray(data.catalog) ? data.catalog : []);
      setGeneratedAt(data.catalog_generated_at || null);
      if (data.catalog_error) setError(data.catalog_error);
    } catch (e) {
      setError(e.message);
      setCatalog([]);
    }
  }

  useEffect(() => {
    if (catalog === null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // The scrape takes minutes; poll until it finishes, then reload the list in
  // place so the user never has to reopen the dialog.
  function startPoll() {
    stopPoll();
    setRefreshing(true);
    pollRef.current = setInterval(async () => {
      let s;
      try {
        s = await apiGet('/image-models/refresh');
      } catch {
        return; // transient — keep polling
      }
      if (s?.running) {
        setRefreshProgress(s.progress || 'Refreshing…');
        return;
      }
      stopPoll();
      setRefreshing(false);
      setRefreshProgress(null);
      if (s?.error) setError(`Catalog refresh failed: ${s.error}`);
      load();
    }, 2000);
  }

  // A refresh kicked off elsewhere (another tab, the video dialog's sibling
  // job) may already be running when this mounts — pick it up.
  useEffect(() => {
    let cancelled = false;
    apiGet('/image-models/refresh')
      .then((s) => {
        if (cancelled || !s?.running) return;
        setRefreshProgress(s.progress || 'Refreshing…');
        startPoll();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshCatalog() {
    setError(null);
    try {
      const r = await apiPostJson('/image-models/refresh', {});
      setRefreshProgress(r?.state?.progress || 'Refreshing…');
      startPoll();
    } catch (e) {
      let msg = e.message || 'Catalog refresh failed.';
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error) msg = parsed.error;
      } catch {}
      setError(msg);
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sort);
    } catch {}
  }, [sort]);

  // The pool the picker draws from: edit flows only ever see models that can
  // take the image being edited as a reference.
  const eligible = useMemo(() => {
    let rows = catalog || [];
    if (requireReferences) rows = rows.filter((m) => m.accepts_references);
    if (promptOnly) rows = rows.filter((m) => !m.requires_references);
    return rows;
  }, [catalog, requireReferences, promptOnly]);

  const filtered = useMemo(() => {
    const rows = eligible;
    const q = query.trim().toLowerCase();
    const matched = rows.filter((m) => {
      if (refsOnly && !m.accepts_references) return false;
      if (!q) return true;
      return (
        m.display_name.toLowerCase().includes(q) ||
        m.endpoint_id.toLowerCase().includes(q) ||
        (m.lab || '').toLowerCase().includes(q) ||
        (m.description || '').toLowerCase().includes(q)
      );
    });
    return sortImageModels(matched, sort);
  }, [eligible, query, refsOnly, sort]);

  // A remembered id can disappear (renamed endpoint, a refresh that dropped
  // it, or a prompt-only model remembered by a generate dialog while this is
  // an edit flow). Fall back to the first eligible model rather than leaving
  // nothing selected and letting the user submit an id the server will reject.
  useEffect(() => {
    if (!eligible.length) return;
    if (eligible.some((m) => m.id === value)) return;
    onChange?.(eligible[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, value]);

  // Keep the current choice visible even when it doesn't match the filter —
  // otherwise the list looks like nothing is selected.
  const selected = eligible.find((m) => m.id === value) || null;
  const rows = selected && !filtered.some((m) => m.id === value)
    ? [selected, ...filtered]
    : filtered;

  if (catalog === null) {
    return <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Loading models…</p>;
  }

  return (
    <div className="image-model-select">
      <div className="image-model-select-controls">
        <input
          type="search"
          className="ref-picker-search"
          placeholder="Search models, labs, endpoints…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled}
        />
        {!requireReferences && !promptOnly && (
          <label className="image-model-select-toggle" title="Only models that accept reference images">
            <input
              type="checkbox"
              checked={refsOnly}
              onChange={(e) => setRefsOnly(e.target.checked)}
              disabled={disabled}
            />
            Takes references
          </label>
        )}
        <select
          className="image-model-select-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          disabled={disabled}
          title="Models without a published price stay at the bottom either way"
        >
          {IMAGE_MODEL_SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div
        className="image-model-select-list"
        style={compact ? { maxHeight: 200 } : undefined}
      >
        {rows.length === 0 ? (
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, padding: '6px 2px' }}>
            No models match “{query}”.
          </p>
        ) : (
          rows.map((m) => (
            <label
              key={m.id}
              className={`image-model-row${value === m.id ? ' is-selected' : ''}`}
            >
              <input
                type="radio"
                name="image-model-select"
                value={m.id}
                checked={value === m.id}
                onChange={() => onChange?.(m.id)}
                disabled={disabled}
              />
              <span className="image-model-row-main">
                <span className="image-model-row-title">
                  {m.display_name}
                  {m.is_wired && <span className="image-model-badge">tuned</span>}
                  {m.requires_references && (
                    <span className="image-model-badge is-muted">needs a reference</span>
                  )}
                </span>
                <span className="image-model-row-meta">
                  {[m.lab, m.category, m.accepts_references ? 'takes references' : 'prompt only']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="image-model-row-price">
                {m.price?.display || '—'}
              </span>
            </label>
          ))
        )}
      </div>

      <div className="image-model-select-footer">
        <span>
          {filtered.length} of {eligible.length} models
          {generatedAt ? ` · catalog ${new Date(generatedAt).toLocaleDateString()}` : ''}
        </span>
        <button
          type="button"
          onClick={refreshCatalog}
          disabled={disabled || refreshing}
          title="Re-scrape fal.ai for new models and current prices"
        >
          {refreshing ? (refreshProgress || 'Refreshing…') : 'Refresh catalog'}
        </button>
      </div>
    </div>
  );
}
