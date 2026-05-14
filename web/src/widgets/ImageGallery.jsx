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
  editPath,
  moveToLibraryPath,
  attachPath,
  generatePath,
  characterSourcesPath,
  beatSourcesPath,
  copyPath,
  pickerTitle = 'Add image',
  // Optional controlled-mode props. When `pickerOpen` is supplied the parent
  // owns the open/close state; otherwise the gallery manages it locally.
  pickerOpen: pickerOpenProp,
  onPickerOpenChange,
  hideAddButton = false,
}) {
  const [error, setError] = useState(null);
  const [editingImageId, setEditingImageId] = useState(null);
  const [regenBusyId, setRegenBusyId] = useState(null);
  const [moveBusyId, setMoveBusyId] = useState(null);
  const [internalPickerOpen, setInternalPickerOpen] = useState(false);
  const pickerOpen = pickerOpenProp ?? internalPickerOpen;
  const setPickerOpen = onPickerOpenChange ?? setInternalPickerOpen;

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
      {uploadPath && !hideAddButton && (
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
          characterSourcesPath={characterSourcesPath || null}
          beatSourcesPath={beatSourcesPath || null}
          copyPath={copyPath || null}
          onAttached={onChange}
        />
      )}
    </div>
  );
}
