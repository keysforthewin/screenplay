import { useMemo, useRef, useState } from 'react';
import { apiDelete, apiPostMultipart, imageUrl, thumbUrl } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { AttachmentList } from './AttachmentList.jsx';

// Tiny client-side stripper — used to apply the TOC filter against
// rendered-text values of the markdown name field. Mirrors the spirit of
// src/util/markdown.js stripMarkdown but only what we need here.
function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function LibraryPanel({ data, session, onChange, query }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const imgInput = useRef(null);

  async function uploadImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart('/library/image', fd);
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (imgInput.current) imgInput.current.value = '';
    }
  }

  async function deleteImage(id) {
    if (!confirm('Delete library image?')) return;
    try {
      await apiDelete(`/library/image/${id}`);
      await onChange();
    } catch (e) {
      setError(e.message);
    }
  }

  const filter = String(query || '').trim().toLowerCase();
  const visibleImages = useMemo(() => {
    if (!filter) return data.images || [];
    return (data.images || []).filter((img) => {
      const name = stripMd(img.name).toLowerCase();
      const desc = String(img.description || '').toLowerCase();
      return name.includes(filter) || desc.includes(filter);
    });
  }, [data.images, filter]);

  if (!session?.session_id) {
    return (
      <>
        {error && <div className="error-banner">{error}</div>}
        <p style={{ color: 'var(--fg-muted)' }}>Sign in to edit the library.</p>
      </>
    );
  }

  return (
    <CollabSurface room="library" session={session} onPing={onChange}>
      {error && <div className="error-banner">{error}</div>}

      <section className="field-block">
        <div className="library-section-head">
          <h2 className="library-section-title">Images</h2>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => imgInput.current?.click()}
          >
            + Add image
          </button>
          <input
            ref={imgInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={uploadImage}
            hidden
          />
        </div>
        {visibleImages.length === 0 && (
          <p style={{ color: 'var(--fg-muted)' }}>
            {filter ? `No library images match “${query}”.` : 'No images yet.'}
          </p>
        )}
        <div className="library-list">
          {visibleImages.map((img) => (
            <div key={img._id} className="library-row">
              <div className="library-thumb">
                <a
                  href={imageUrl(img._id)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open full size in new tab"
                >
                  <img src={thumbUrl(img._id)} alt={stripMd(img.name) || img.filename} loading="lazy" />
                </a>
              </div>
              <div className="library-meta">
                <CollabField
                  field={`library:${img._id}:name`}
                  placeholder="Untitled"
                />
                <CollabField
                  field={`library:${img._id}:description`}
                  multiline
                  placeholder="Description…"
                />
              </div>
              <div className="library-actions">
                <a
                  className="icon-link"
                  href={imageUrl(img._id)}
                  download={img.filename || `image-${img._id}`}
                  title={`Download ${img.filename || 'image'}`}
                >
                  Download
                </a>
                <button onClick={() => deleteImage(img._id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="field-block" style={{ marginTop: 32 }}>
        <div className="library-section-head">
          <h2 className="library-section-title">Attachments</h2>
        </div>
        {(data.attachments || []).length === 0 && (
          <p style={{ color: 'var(--fg-muted)' }}>No attachments yet.</p>
        )}
        <AttachmentList
          attachments={data.attachments || []}
          onChange={onChange}
          uploadPath="/library/attachment"
          deletePath={(id) => `/library/attachment/${id}`}
          fieldPrefix="library_attachment"
        />
      </section>
    </CollabSurface>
  );
}
