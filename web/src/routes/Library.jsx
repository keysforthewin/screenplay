import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api.js';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';
import { LibraryPanel } from '../widgets/LibraryPanel.jsx';

export function Library({ session }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    try {
      const r = await apiGet('/library');
      setData(r);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading library…</p></div>;

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
        <h1 style={{ marginTop: 0 }}>Library</h1>
        <DownloadAllButton
          path="/library/download"
          filename="library.zip"
          disabled={data.images.length === 0 && data.attachments.length === 0}
        />
      </div>

      <LibraryPanel data={data} session={session} onChange={load} />
    </main>
  );
}
