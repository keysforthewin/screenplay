import { apiDelete, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageGallery } from './ImageGallery.jsx';

export function NotesPanel({ notes, session, onChange }) {
  async function addNote() {
    await apiPostJson('/notes', { text: '_New note_' });
    onChange();
  }

  async function removeNote(id) {
    if (!confirm('Delete this note?')) return;
    await apiDelete(`/notes/${id}`);
    onChange();
  }

  return (
    <>
      <CollabSurface room="notes" session={session} onPing={onChange}>
        {notes.length === 0 && (
          <p style={{ color: 'var(--fg-muted)' }}>No notes yet.</p>
        )}
        {notes.map((note) => (
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
              onChange={onChange}
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
    </>
  );
}
