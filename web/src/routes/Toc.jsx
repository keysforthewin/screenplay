import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api.js';

export function Toc() {
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
    return () => { cancelled = true; };
  }, []);

  const filter = useMemo(() => query.trim().toLowerCase(), [query]);
  const matches = (label) => !filter || label.toLowerCase().includes(filter);

  if (error) {
    return (
      <div className="app">
        <div className="error-banner">Could not load table of contents: {error}</div>
      </div>
    );
  }

  if (!toc) {
    return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading…</p></div>;
  }

  const notesLabel = `All notes (${toc.notes_count || 0})`;
  const notesItems = matches(notesLabel)
    ? [{ key: 'all', to: '/notes', label: notesLabel }]
    : [];

  const characters = [...(toc.characters || [])]
    .sort((a, b) => {
      const an = (a.plain_name || a.name || '').toLowerCase();
      const bn = (b.plain_name || b.name || '').toLowerCase();
      return an.localeCompare(bn);
    })
    .map((c) => ({
      key: c._id,
      to: `/character/${encodeURIComponent(c.plain_name || c.name)}`,
      label: c.plain_name || c.name || '',
    }))
    .filter((c) => matches(c.label));

  const beats = [...(toc.beats || [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((b) => ({
      key: b._id,
      to: `/beat/${b.order}`,
      label: `#${b.order} — ${b.plain_name || b.name || 'Untitled'}`,
    }))
    .filter((b) => matches(b.label));

  const libraryItems = matches('Browse library')
    ? [{ key: 'browse', to: '/library', label: 'Browse library' }]
    : [];

  const allEmpty =
    filter &&
    notesItems.length === 0 &&
    characters.length === 0 &&
    beats.length === 0 &&
    libraryItems.length === 0;

  return (
    <main className="app">
      <h1 style={{ marginBottom: 8 }}>Table of contents</h1>

      <div className="toc-filter">
        <input
          type="search"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter table of contents"
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

      {allEmpty && (
        <p style={{ color: 'var(--fg-muted)' }}>No items match “{query}”.</p>
      )}

      {notesItems.length > 0 && (
        <section className="toc-section">
          <h2>Director's notes</h2>
          <ul>
            {notesItems.map((it) => (
              <li key={it.key}><Link to={it.to}>{it.label}</Link></li>
            ))}
          </ul>
        </section>
      )}

      {(beats.length > 0 || (!filter && (toc.beats || []).length === 0)) && (
        <section className="toc-section">
          <h2>Beats</h2>
          {beats.length === 0 && (
            <p style={{ color: 'var(--fg-muted)' }}>No beats yet.</p>
          )}
          <ul>
            {beats.map((b) => (
              <li key={b.key}><Link to={b.to}>{b.label}</Link></li>
            ))}
          </ul>
        </section>
      )}

      {(characters.length > 0 || (!filter && (toc.characters || []).length === 0)) && (
        <section className="toc-section">
          <h2>Characters</h2>
          {characters.length === 0 && (
            <p style={{ color: 'var(--fg-muted)' }}>No characters yet.</p>
          )}
          <ul>
            {characters.map((c) => (
              <li key={c.key}><Link to={c.to}>{c.label}</Link></li>
            ))}
          </ul>
        </section>
      )}

      {libraryItems.length > 0 && (
        <section className="toc-section">
          <h2>Library</h2>
          <ul>
            {libraryItems.map((it) => (
              <li key={it.key}><Link to={it.to}>{it.label}</Link></li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
