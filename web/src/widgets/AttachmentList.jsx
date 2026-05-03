import { useRef, useState } from 'react';
import { apiDelete, apiPostMultipart, attachmentUrl } from '../api.js';

export function AttachmentList({
  attachments,
  onChange,
  uploadPath,
  deletePath,
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
      <ul className="attachment-list">
        {(attachments || []).map((a) => {
          const id = a._id.toString ? a._id.toString() : String(a._id);
          return (
            <li key={id}>
              <a href={attachmentUrl(id)} target="_blank" rel="noreferrer">
                {a.filename || id}
              </a>
              {deletePath && <button onClick={() => remove(id)}>Delete</button>}
            </li>
          );
        })}
      </ul>
      {uploadPath && <input ref={fileInput} type="file" onChange={upload} disabled={busy} />}
    </div>
  );
}
