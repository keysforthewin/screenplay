import { useState } from 'react';
import { apiDownload } from '../api.js';

export function DownloadAllButton({ path, filename, label = 'Download all', disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await apiDownload(path, filename);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button onClick={onClick} disabled={busy || disabled} title={`Download a zip of all images and attachments`}>
        {busy ? 'Preparing zip…' : label}
      </button>
      {error && <span style={{ color: 'var(--danger, #c66)', fontSize: 12 }}>{error}</span>}
    </span>
  );
}
