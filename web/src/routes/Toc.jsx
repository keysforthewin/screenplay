import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../api.js';

export function Toc() {
  const [toc, setToc] = useState(null);
  const [error, setError] = useState(null);

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

  const beats = [...(toc.beats || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const characters = [...(toc.characters || [])].sort((a, b) => {
    const an = (a.plain_name || a.name || '').toLowerCase();
    const bn = (b.plain_name || b.name || '').toLowerCase();
    return an.localeCompare(bn);
  });

  return (
    <main className="app">
      <h1 style={{ marginBottom: 8 }}>Table of contents</h1>

      <section className="toc-section">
        <h2>Director's notes</h2>
        <ul>
          <li>
            <Link to="/notes">All notes ({toc.notes_count || 0})</Link>
          </li>
        </ul>
      </section>

      <section className="toc-section">
        <h2>Characters</h2>
        {characters.length === 0 && <p style={{ color: 'var(--fg-muted)' }}>No characters yet.</p>}
        <ul>
          {characters.map((c) => (
            <li key={c._id}>
              <Link to={`/character/${encodeURIComponent(c.plain_name || c.name)}`}>
                {c.plain_name || c.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="toc-section">
        <h2>Beats</h2>
        {beats.length === 0 && <p style={{ color: 'var(--fg-muted)' }}>No beats yet.</p>}
        <ul>
          {beats.map((b) => (
            <li key={b._id}>
              <Link to={`/beat/${b.order}`}>
                #{b.order} — {b.plain_name || b.name || 'Untitled'}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="toc-section">
        <h2>Library</h2>
        <ul>
          <li><Link to="/library">Browse library</Link></li>
        </ul>
      </section>
    </main>
  );
}
