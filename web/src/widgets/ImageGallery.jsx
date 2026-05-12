import { useState } from 'react';
import { apiDelete, apiPostJson, imageUrl, thumbUrl } from '../api.js';
import { CollabField } from '../editor/CollabField.jsx';
import { ImageEditDialog } from './ImageEditDialog.jsx';
import { EntityImagePickerModal } from './EntityImagePickerModal.jsx';

export function ImageGallery({
  images,
  mainImageId,
  onChange,
  uploadPath,
  deletePath,
  mainPath,
  // Optional. When provided, an "Edit" button opens a dialog that POSTs to
  // editPath(imageId) with { mode, image_model, prompt } and replaces the
  // image in place. Use on entity-owned galleries (beat/character); skip on
  // the library where regenerate isn't wired up.
  editPath,
  // Optional. When provided, a "Move to library" button POSTs to
  // moveToLibraryPath(imageId). Use on entity-owned galleries.
  moveToLibraryPath,
  // Optional. POST {image_id} — attach an existing library image. Enables
  // the Library tab in the picker.
  attachPath,
  // Optional. POST {prompt, model} — generate a new image. Enables the
  // Generate tab in the picker.
  generatePath,
  // Title used in the picker modal header.
  pickerTitle = 'Add image',
}) {
  const [error, setError] = useState(null);
  const [editingImageId, setEditingImageId] = useState(null);
  const [regenBusyId, setRegenBusyId] = useState(null);
  const [moveBusyId, setMoveBusyId] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);

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

  async function moveToLibrary(id) {
    if (!moveToLibraryPath) return;
    if (!confirm('Move this image to the library?')) return;
    setMoveBusyId(id);
    setError(null);
    try {
      await apiPostJson(moveToLibraryPath(id), {});
      await onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setMoveBusyId(null);
    }
  }

  async function submitEdit({ mode, imageModel, prompt }) {
    if (!editPath || !editingImageId) return;
    const id = editingImageId;
    setEditingImageId(null);
    setRegenBusyId(id);
    setError(null);
    try {
      await apiPostJson(editPath(id), {
        mode,
        image_model: imageModel,
        prompt,
      });
      await onChange?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setRegenBusyId(null);
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
          const regenBusy = regenBusyId === id;
          const moveBusy = moveBusyId === id;
          return (
            <div key={id} className={`gallery-row${isMain ? ' is-main' : ''}`}>
              <div className="gallery-thumb">
                <a
                  href={imageUrl(id)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open full size in new tab"
                >
                  <img src={thumbUrl(id)} alt={img.filename || ''} loading="lazy" />
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
                {editPath && (
                  <button
                    onClick={() => setEditingImageId(id)}
                    disabled={regenBusy}
                    title="Edit or regenerate this image with an AI model"
                  >
                    {regenBusy ? 'Editing…' : 'Edit…'}
                  </button>
                )}
                {moveToLibraryPath && (
                  <button
                    onClick={() => moveToLibrary(id)}
                    disabled={moveBusy}
                    title="Detach from this entity and put back in the library"
                  >
                    {moveBusy ? 'Moving…' : 'To library'}
                  </button>
                )}
                {deletePath && <button onClick={() => remove(id)}>Delete</button>}
              </div>
            </div>
          );
        })}
      </div>
      {uploadPath && (
        <div className="gallery-add">
          <button
            type="button"
            className="primary"
            onClick={() => setPickerOpen(true)}
          >
            + Add image
          </button>
        </div>
      )}
      {editPath && (
        <ImageEditDialog
          open={!!editingImageId}
          onClose={() => setEditingImageId(null)}
          onSubmit={submitEdit}
        />
      )}
      {uploadPath && (
        <EntityImagePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          title={pickerTitle}
          uploadPath={uploadPath}
          attachPath={attachPath || null}
          generatePath={generatePath || null}
          onAttached={onChange}
        />
      )}
    </div>
  );
}
