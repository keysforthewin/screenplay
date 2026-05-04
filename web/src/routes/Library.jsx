import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiDelete, apiGet, apiPostMultipart, imageUrl, attachmentUrl } from '../api.js';
import { DownloadAllButton } from '../widgets/DownloadAllButton.jsx';

export function Library() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const imgInput = useRef(null);
  const fileInput = useRef(null);

  async function load() {
    try {
      const r = await apiGet('/library');
      setData(r);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function uploadImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart('/library/image', fd);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (imgInput.current) imgInput.current.value = '';
    }
  }

  async function uploadAttachment(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart('/library/attachment', fd);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function deleteImage(id) {
    if (!confirm('Delete library image?')) return;
    try {
      await apiDelete(`/library/image/${id}`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteAttachment(id) {
    if (!confirm('Delete library attachment?')) return;
    try {
      await apiDelete(`/library/attachment/${id}`);
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

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

      <section className="field-block">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Images</h2>
          <input
            ref={imgInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={uploadImage}
            disabled={busy}
          />
        </div>
        {data.images.length === 0 && <p style={{ color: 'var(--fg-muted)' }}>No images yet.</p>}
        <div className="image-grid" style={{ marginTop: 12 }}>
          {data.images.map((img) => (
            <div key={img._id} className="image-card">
              <img src={imageUrl(img._id)} alt={img.filename} />
              <div className="actions">
                <span title={img.filename} style={{ fontSize: 12, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {img.filename}
                </span>
                <button onClick={() => deleteImage(img._id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="field-block" style={{ marginTop: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Attachments</h2>
          <input ref={fileInput} type="file" onChange={uploadAttachment} disabled={busy} />
        </div>
        {data.attachments.length === 0 && (
          <p style={{ color: 'var(--fg-muted)' }}>No attachments yet.</p>
        )}
        <ul className="attachment-list">
          {data.attachments.map((a) => (
            <li key={a._id}>
              <a href={attachmentUrl(a._id)} target="_blank" rel="noreferrer">{a.filename}</a>
              <button onClick={() => deleteAttachment(a._id)}>Delete</button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
