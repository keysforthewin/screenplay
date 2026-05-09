import { useRef, useState } from 'react';
import { apiDelete, apiPostJson, apiPostMultipart, imageUrl } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';

export function ImageGallery({
  images,
  mainImageId,
  onChange,
  uploadPath,
  deletePath,
  mainPath,
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

  async function setMain(id) {
    if (!mainPath) return;
    try {
      await apiPostJson(mainPath, { image_id: id });
      await onChange?.();
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(id) {
    if (!deletePath) return;
    if (!confirm('Remove this image?')) return;
    try {
      await apiDelete(deletePath(id));
      await onChange?.();
    } catch (e) {
      setError(e.message);
    }
  }

  const mainId = mainImageId?.toString?.() || (typeof mainImageId === 'string' ? mainImageId : null);

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="image-gallery-list" style={{ marginBottom: 8 }}>
        {(images || []).map((img) => {
          const id = img._id.toString ? img._id.toString() : String(img._id);
          const isMain = mainId && id === mainId;
          return (
            <div key={id} className={`gallery-row${isMain ? ' is-main' : ''}`}>
              <div className="gallery-thumb">
                <a
                  href={imageUrl(id)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open full size in new tab"
                >
                  <img src={imageUrl(id)} alt={img.filename || ''} loading="lazy" />
                </a>
              </div>
              <div className="gallery-meta">
                <CollabField
                  field={`image:${id}:name`}
                  placeholder="Untitled"
                />
                <CollabField
                  field={`image:${id}:description`}
                  multiline
                  placeholder="Description…"
                />
              </div>
              <div className="gallery-actions">
                {isMain ? (
                  <span style={{ color: 'var(--accent)', fontSize: 12 }}>★ main</span>
                ) : (
                  mainPath && <button onClick={() => setMain(id)}>Set main</button>
                )}
                <a
                  className="icon-link"
                  href={imageUrl(id)}
                  download={img.filename || `image-${id}`}
                  title={`Download ${img.filename || 'image'}`}
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
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={upload}
          disabled={busy}
        />
      )}
    </div>
  );
}
