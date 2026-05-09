import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api.js';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';
import { NotesPanel } from '../widgets/NotesPanel.jsx';

export function Notes({ session }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet('/notes');
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  function onRefresh() { setRefreshKey((k) => k + 1); }

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading notes…</p></div>;

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>Director's notes</h1>
        <DownloadAllButton
          path="/notes/download"
          filename="director-notes.zip"
          disabled={(data.notes || []).length === 0}
        />
      </div>

      <NotesPanel notes={data.notes || []} session={session} onChange={onRefresh} />
    </main>
  );
}
