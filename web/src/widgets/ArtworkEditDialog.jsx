import { useEffect, useState } from 'react';
import { InlineImageEditDialog } from './InlineImageEditDialog.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { apiPostJson } from '../api.js';

const MODEL_STORAGE_KEY = 'screenplay.artworkEdit.model';

// In-line artwork editor. Edits the artwork's current result image in place,
// optionally with extra reference images that the model can incorporate
// alongside the existing image. References are one-shot per edit — not
// persisted on the artwork doc; the next dialog open starts empty.
//
// Lifecycle:
//   1. User types prompt, optionally picks references → clicks Apply.
//   2. Dialog POSTs /<host>/<id>/artwork/<artworkId>/edit with
//      {prompt, model, reference_image_ids}. The route flips the artwork to
//      status='pending' and returns immediately.
//   3. Dialog stays open showing a spinner. The parent re-renders when the
//      Hocuspocus fields_updated broadcast lands (CollabSurface →
//      onPing → setRefreshKey); the parent passes the fresh artwork doc
//      back in via `artwork` prop, so we see status flip to 'done' and
//      the new result_image_id.
//   4. Undo: synchronous POST .../undo → swaps previous → current.
export function ArtworkEditDialog({
  open,
  onClose,
  onDone,
  hostType,
  hostId,
  hostLabel,
  hostImages = [],
  hostArtworks = [],
  artwork,
}) {
  const artworkId =
    artwork?._id?.toString?.() ||
    (artwork?._id ? String(artwork._id) : null);
  const basePath = `/${hostType}/${hostId}/artwork/${artworkId}`;
  const status =
    artwork?.status || (artwork?.result_image_id ? 'done' : 'pending');
  const hasUndo = !!artwork?.previous_result_image_id;
  const resultId =
    artwork?.result_image_id?.toString?.() ||
    (artwork?.result_image_id ? String(artwork.result_image_id) : null);

  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setReferenceIds([]);
      setPickerOpen(false);
    }
  }, [open, artworkId]);

  async function applyEdit({ prompt, model, referenceIds: refs }) {
    if (!artworkId) throw new Error('Artwork id missing');
    await apiPostJson(`${basePath}/edit`, {
      prompt,
      model,
      reference_image_ids: Array.isArray(refs) ? refs : [],
    });
    setReferenceIds([]);
  }

  async function undoEdit() {
    if (!artworkId) throw new Error('Artwork id missing');
    await apiPostJson(`${basePath}/undo`, {});
  }

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }

  return (
    <>
      <InlineImageEditDialog
        open={open}
        onClose={onClose}
        onDone={onDone}
        title="Edit artwork"
        imageId={resultId}
        status={status}
        errorMessage={artwork?.error_message || null}
        hasUndo={hasUndo}
        applyEdit={artworkId ? applyEdit : null}
        undoEdit={artworkId ? undoEdit : null}
        modelStorageKey={MODEL_STORAGE_KEY}
        referenceIds={referenceIds}
        onPickReferences={() => setPickerOpen(true)}
        onRemoveReference={removeReference}
      />
      <ArtworkReferencePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onApply={(ids) => setReferenceIds(ids)}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
        selectedIds={referenceIds}
        excludeImageId={resultId}
      />
    </>
  );
}
