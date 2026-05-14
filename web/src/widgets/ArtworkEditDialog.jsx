import { InlineImageEditDialog } from './InlineImageEditDialog.jsx';
import { apiPostJson } from '../api.js';

const MODEL_STORAGE_KEY = 'screenplay.artworkEdit.model';

// In-line artwork editor. Strictly single-image image-to-image edits — the
// dialog feeds the artwork's current result_image_id as the input image plus
// the user's prompt and chosen model; the new result replaces the current one
// and the immediately-previous result is kept so the user can Undo one step.
//
// Lifecycle:
//   1. User types prompt → clicks Apply.
//   2. Dialog POSTs /<host>/<id>/artwork/<artworkId>/edit. The route flips
//      the artwork to status='pending' and returns immediately.
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

  async function applyEdit({ prompt, model }) {
    if (!artworkId) throw new Error('Artwork id missing');
    await apiPostJson(`${basePath}/edit`, { prompt, model });
  }

  async function undoEdit() {
    if (!artworkId) throw new Error('Artwork id missing');
    await apiPostJson(`${basePath}/undo`, {});
  }

  return (
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
    />
  );
}
