import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api.js';

// Index of the Prompts tab: one row per beat linking to /prompts/:order, with
// the number of video prompts the beat has. Mirrors DialogIndex.
export function PromptsIndex() {
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
        <div className="error-banner">Could not load prompts: {error}</div>
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
      to: `/prompts/${b.order}`,
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
      <h1 style={{ marginBottom: 8 }}>Prompts</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
        Each beat has its own video prompts — self-contained multi-shot prompts with reference
        images, ready to render. <strong>*</strong> marks beats with no prompts yet.
      </p>

      <div className="toc-filter">
        <input
          type="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter prompts"
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
            {beats.map((b) => {
              const prefix = b.missing ? '* ' : '';
              const suffix = b.missing ? '' : ` (${b.count})`;
              const text = `${prefix}#${b.order} — ${b.title}${suffix}`;
              return (
                <li key={b.key}>
                  <Link to={b.to} title={b.missing ? 'No prompts for this beat yet' : undefined}>
                    {text}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
