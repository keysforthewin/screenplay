import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';

// Facet search over ElevenLabs' shared voice library. Facet option lists are
// curated constants — the API has no facets endpoint. Every filter maps 1:1
// to a GET /v1/shared-voices query param (proxied by /api/eleven/library).

const GENDERS = ['male', 'female', 'neutral'];
const AGES = ['young', 'middle_aged', 'old'];
const CATEGORIES = ['professional', 'famous', 'high_quality'];
const ACCENTS = [
  'american', 'british', 'australian', 'canadian', 'irish', 'scottish',
  'south african', 'indian', 'nigerian', 'jamaican', 'new zealand',
];
const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['pl', 'Polish'], ['hi', 'Hindi'],
  ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['nl', 'Dutch'], ['tr', 'Turkish'], ['sv', 'Swedish'], ['ru', 'Russian'],
  ['uk', 'Ukrainian'], ['cs', 'Czech'], ['fi', 'Finnish'], ['ro', 'Romanian'],
];
const USE_CASES = [
  'narrative_story', 'conversational', 'characters_animation', 'social_media',
  'entertainment_tv', 'advertisement', 'informative_educational',
];
const DESCRIPTIVES = [
  'calm', 'confident', 'deep', 'warm', 'energetic', 'authoritative', 'soft',
  'raspy', 'crisp', 'husky', 'intense', 'gentle', 'playful', 'serious',
  'sassy', 'wise', 'youthful', 'gruff',
];

const EMPTY_FILTERS = {
  search: '', gender: '', age: '', accent: '', language: '',
  category: '', use_case: '', descriptive: '', featured: false,
};

function FacetSelect({ label, value, options, onChange }) {
  return (
    <label className="eleven-facet">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">any</option>
        {options.map((o) => {
          const [val, text] = Array.isArray(o) ? o : [o, o.replace(/_/g, ' ')];
          return <option key={val} value={val}>{text}</option>;
        })}
      </select>
    </label>
  );
}

export function VoiceLibraryBrowser({ collectionIds, onAdded }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [items, setItems] = useState(null); // null = not loaded
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [addingId, setAddingId] = useState(null);
  const debounceRef = useRef(null);
  const playerRef = useRef(null);
  const reqIdRef = useRef(0);

  function setFilter(key, value) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(0);
  }

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const reqId = ++reqIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(filters)) {
          if (v === '' || v === false) continue;
          params.set(k, String(v));
        }
        params.set('page', String(page));
        const r = await apiGet(`/eleven/library?${params}`);
        if (reqId !== reqIdRef.current) return;
        setItems(r.voices || []);
        setHasMore(Boolean(r.has_more));
      } catch (e) {
        if (reqId !== reqIdRef.current) return;
        setError(e.message);
      } finally {
        if (reqId === reqIdRef.current) {
          setLoading(false);
        }
      }
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [filters, page]);

  function preview(url) {
    if (!url) return;
    if (!playerRef.current) playerRef.current = new Audio();
    const p = playerRef.current;
    if (p.src === url && !p.paused) {
      p.pause();
    } else {
      p.src = url;
      p.play().catch(() => {});
    }
  }

  useEffect(() => () => playerRef.current?.pause(), []);

  async function add(v) {
    setAddingId(v.voice_id);
    setError(null);
    try {
      await apiPostJson('/eleven/collection', {
        voice_id: v.voice_id,
        public_owner_id: v.public_owner_id,
        name: v.name,
        description: v.description,
        preview_url: v.preview_url,
        category: v.category,
        labels: {
          gender: v.gender, age: v.age, accent: v.accent,
          language: v.language, use_case: v.use_case, descriptive: v.descriptive,
        },
      });
      onAdded();
    } catch (e) {
      setError(e.message);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="eleven-library">
      {error && <div className="error-banner">{error}</div>}
      <div className="eleven-library-filters">
        <input
          type="search"
          placeholder="Search voices by name or description…"
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
        />
        <FacetSelect label="Gender" value={filters.gender} options={GENDERS} onChange={(v) => setFilter('gender', v)} />
        <FacetSelect label="Age" value={filters.age} options={AGES} onChange={(v) => setFilter('age', v)} />
        <FacetSelect label="Accent" value={filters.accent} options={ACCENTS} onChange={(v) => setFilter('accent', v)} />
        <FacetSelect label="Language" value={filters.language} options={LANGUAGES} onChange={(v) => setFilter('language', v)} />
        <FacetSelect label="Category" value={filters.category} options={CATEGORIES} onChange={(v) => setFilter('category', v)} />
        <FacetSelect label="Use case" value={filters.use_case} options={USE_CASES} onChange={(v) => setFilter('use_case', v)} />
        <FacetSelect label="Style" value={filters.descriptive} options={DESCRIPTIVES} onChange={(v) => setFilter('descriptive', v)} />
        <label className="playground-filter-check">
          <input
            type="checkbox"
            checked={filters.featured}
            onChange={(e) => setFilter('featured', e.target.checked)}
          />
          featured
        </label>
      </div>

      {loading && <p className="playground-empty">Searching voices…</p>}
      {!loading && items && items.length === 0 && (
        <p className="playground-empty">No voices match — loosen a filter or two.</p>
      )}
      <div className="eleven-voice-cards">
        {(items || []).map((v) => {
          const inCollection = collectionIds.has(v.voice_id);
          const labels = [v.gender, v.age, v.accent, v.language, v.use_case?.replace(/_/g, ' '), v.descriptive]
            .filter(Boolean);
          return (
            <div key={v.voice_id} className="eleven-voice-card">
              <div className="eleven-voice-card-head">
                <button
                  type="button"
                  className="eleven-preview-btn"
                  title="Preview"
                  disabled={!v.preview_url}
                  onClick={() => preview(v.preview_url)}
                >
                  ▶
                </button>
                <strong>{v.name}</strong>
                <span className="playground-model-badge">{v.category}</span>
              </div>
              {labels.length > 0 && (
                <div className="eleven-voice-labels">
                  {labels.map((l) => <span key={l} className="eleven-voice-label">{l}</span>)}
                </div>
              )}
              {v.description && <p className="eleven-voice-desc">{v.description}</p>}
              <button
                type="button"
                disabled={inCollection || addingId === v.voice_id}
                onClick={() => add(v)}
              >
                {inCollection ? '✓ In collection' : addingId === v.voice_id ? 'Adding…' : '+ Add to collection'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="eleven-library-pager">
        <button type="button" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
          ← Prev
        </button>
        <span>page {page + 1}</span>
        <button type="button" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
          Next →
        </button>
      </div>
    </div>
  );
}
