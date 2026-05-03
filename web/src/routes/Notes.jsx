import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiDelete, apiGet, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from '../widgets/ImageGallery.jsx';

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

  async function addNote() {
    await apiPostJson('/notes', { text: '_New note_' });
    onRefresh();
  }

  async function removeNote(id) {
    if (!confirm('Delete this note?')) return;
    await apiDelete(`/notes/${id}`);
    onRefresh();
  }

  if (error) return <div className="app"><div className="error-banner">{error}</div></div>;
  if (!data) return <div className="app"><p style={{ color: 'var(--fg-muted)' }}>Loading notes…</p></div>;

  return (
    <main className="app">
      <p>
        <a href="#" onClick={(e) => { e.preventDefault(); navigate('/'); }}>← Back to TOC</a>
      </p>
      <h1 style={{ marginTop: 0 }}>Director's notes</h1>

      <CollabSurface room="notes" session={session} onPing={onRefresh}>
        {(data.notes || []).length === 0 && (
          <p style={{ color: 'var(--fg-muted)' }}>No notes yet.</p>
        )}
        {(data.notes || []).map((note) => (
          <div
            key={note._id}
            className="field-block"
            style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="field-label">Note {String(note._id).slice(-6)}</span>
              <button onClick={() => removeNote(note._id)}>Delete</button>
            </div>
            <CollabField field={`note:${note._id}:text`} multiline />
            <ImageGallery
              images={note.images || []}
              mainImageId={note.main_image_id}
              onChange={onRefresh}
              uploadPath={`/notes/${note._id}/image`}
              deletePath={(imageId) => `/notes/${note._id}/image/${imageId}`}
              mainPath={`/notes/${note._id}/main-image`}
            />
          </div>
        ))}
      </CollabSurface>

      <div style={{ marginTop: 24 }}>
        <button className="primary" onClick={addNote}>+ Add note</button>
      </div>
    </main>
  );
}
