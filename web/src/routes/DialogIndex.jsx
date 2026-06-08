import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api.js';

export function DialogIndex() {
  const [toc, setToc] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [style, setStyle] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, s] = await Promise.all([
          apiGet('/toc'),
          apiGet('/plot/dialogue-style').catch(() => ({ dialogue_style: '' })),
        ]);
        if (!cancelled) {
          setToc(t);
          setStyle(s.dialogue_style || '');
        }
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
        <div className="error-banner">Could not load dialog: {error}</div>
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
      to: `/dialog/${b.order}`,
      order: b.order,
      title: b.plain_name || b.name || 'Untitled',
      missing: !b.dialog_count,
      count: b.dialog_count || 0,
    }))
    .filter((b) => matches(`#${b.order} — ${b.title}`));

  return (
    <main className="app">
      <p>
        <Link to="/">← Back to TOC</Link>
      </p>
      <h1 style={{ marginBottom: 8 }}>Dialog</h1>
      <p style={{ color: 'var(--fg-muted)', marginTop: 0 }}>
        Each beat has its own dialog. <strong>*</strong> marks beats with no
        dialog yet.
      </p>

      <section className="dialog-style-panel" style={{ marginBottom: 20 }}>
        <span className="field-label" style={{ display: 'block', marginBottom: 4 }}>
          Global dialogue style &amp; influences
        </span>
        <p style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 0 }}>
          Steers every Generate, Regenerate, and Critique across the whole script.
          Edit it on the <Link to="/about">About page</Link>. Each beat also has its
          own dialogue notes on its dialog page.
        </p>
        {style.trim() ? (
          <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{style}</p>
        ) : (
          <p style={{ color: 'var(--fg-muted)', fontStyle: 'italic', margin: '4px 0 0' }}>
            No global dialogue style set yet.
          </p>
        )}
      </section>

      <div className="toc-filter">
        <input
          type="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter dialog"
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
                  <Link
                    to={b.to}
                    title={b.missing ? 'No dialog for this beat yet' : undefined}
                  >
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
