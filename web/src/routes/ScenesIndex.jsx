import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api.js';

// Index of the Scenes tab: one row per beat linking to /scenes/:order, with
// the number of cuts the beat has. Mirrors DialogIndex.
export function ScenesIndex() {
  const [toc, setToc] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await apiGet('/toc');
        if (!cancelled) setToc(t);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filter = useMemo(() => query.trim().toLowerCase(), [query]);
  const matches = (label) => !filter || label.toLowerCase().includes(filter);

  if (error) {
    return (
      <div className="app">
        <div className="error-banner">Could not load scenes: {error}</div>
      </div>
    );
  }

  if (!toc) {
    return (
      <div className="app">
        <p style={{ color: 'var(--fg-muted)' }}>Loading…</p>
      </div>
    );
  }

  const beats = [...(toc.beats || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b) => ({
      key: b._id,
      to: `/scenes/${b.order}`,
      order: b.order,
      title: b.plain_name || b.name || 'Untitled',
      missing: !b.video_prompt_count,
      count: b.video_prompt_count || 0,
    }))
    .filter((b) => matches(`#${b.order} — ${b.title}`));

  return (
    <main className="app">
      <p>
        <Link to="/">← Back to TOC</Link>
      </p>
      <h1 style={{ marginBottom: 8 }}>Scenes</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
        Each beat has its own scenes and cuts: a cut is a video prompt, a start frame and an end
        frame, then a clip. <strong>*</strong> marks beats with no cuts yet.
      </p>

      <div className="toc-filter">
        <input
          type="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter beats"
          autoFocus
        />
        {query && (
          <button
            type="button"
            className="toc-filter-clear"
            aria-label="Clear filter"
            title="Clear filter"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        )}
      </div>

      {beats.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)' }}>
          {filter ? `No beats match "${query}".` : 'No beats yet.'}
        </p>
      ) : (
        <section className="toc-section">
          <ul>
            {beats.map((b) => (
              <li key={b.key}>
                <Link to={b.to} title={b.missing ? 'No cuts for this beat yet' : undefined}>
                  {`${b.missing ? '* ' : ''}#${b.order} — ${b.title}${b.missing ? '' : ` (${b.count})`}`}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
