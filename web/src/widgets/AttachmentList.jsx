import { useRef, useState } from 'react';
import { apiDelete, apiPostMultipart, attachmentUrl } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fileGlyph(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.startsWith('image/')) return '🖼️';
  if (t.startsWith('audio/')) return '🎵';
  if (t.startsWith('video/')) return '🎬';
  if (t.includes('pdf')) return '📕';
  if (t.startsWith('text/') || t.includes('json') || t.includes('xml')) return '📄';
  if (t.includes('zip') || t.includes('compressed') || t.includes('tar')) return '🗜️';
  return '📎';
}

export function AttachmentList({
  attachments,
  onChange,
  uploadPath,
  deletePath,
  fieldPrefix = 'attachment',
}) {
  const fileInput = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file || !uploadPath) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(uploadPath, fd);
      await onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove(id) {
    if (!deletePath) return;
    if (!confirm('Remove this attachment?')) return;
    try {
      await apiDelete(deletePath(id));
      await onChange?.();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="attachment-gallery-list" style={{ marginBottom: 8 }}>
        {(attachments || []).map((a) => {
          const id = a._id?.toString ? a._id.toString() : String(a._id);
          return (
            <div key={id} className="attachment-row">
              <div className="attachment-file">
                <div className="attachment-glyph" aria-hidden="true">{fileGlyph(a.content_type)}</div>
                <a
                  className="filename"
                  href={attachmentUrl(id)}
                  download={a.filename || id}
                  title={`Download ${a.filename || 'file'}`}
                >
                  {a.filename || id}
                </a>
                {Number.isFinite(a.size) && (
                  <span className="filesize">{formatBytes(a.size)}</span>
                )}
              </div>
              <div className="attachment-meta">
                <CollabField
                  field={`${fieldPrefix}:${id}:name`}
                  placeholder="Untitled"
                />
                <CollabField
                  field={`${fieldPrefix}:${id}:description`}
                  multiline
                  placeholder="Description…"
                />
              </div>
              <div className="attachment-actions">
                <a
                  className="icon-link"
                  href={attachmentUrl(id)}
                  download={a.filename || id}
                  title={`Download ${a.filename || 'file'}`}
                >
                  Download
                </a>
                {deletePath && <button onClick={() => remove(id)}>Delete</button>}
              </div>
            </div>
          );
        })}
      </div>
      {uploadPath && (
        <div className="attachment-add">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            + Add attachment
          </button>
          <input ref={fileInput} type="file" onChange={upload} hidden />
        </div>
      )}
    </div>
  );
}
