import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { apiPostJson, imageUrl, thumbUrl } from '../api.js';
import {
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.artwork.model';

// Generator/regenerator dialog for the Artwork tab on characters AND beats.
// The submit POSTs to /{hostType}/{hostId}/artwork (or /regenerate) which
// returns a pending artwork doc immediately. The dialog closes on success
// and the gallery shows a spinner until the background job completes
// (the SPA re-renders via the Hocuspocus fields_updated broadcast).
//
// Props:
//   hostType: 'character' | 'beat'
//   hostId:   24-hex string
//   hostLabel: optional display label for the picker's "This X" tab
//   hostImages, hostArtworks: candidates for the reference picker
//   artwork: null for new; otherwise the existing artwork meta for regenerate
export function ArtworkDialog({
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
  const isExisting = !!artwork;
  const [imageModel, setImageModel] = useState(() => readStoredImageModel(MODEL_STORAGE_KEY));
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const openSeqRef = useRef(0);

  const basePath = `/${hostType}/${hostId}`;

  useEffect(() => {
    if (!open) {
      openSeqRef.current++;
      return;
    }
    setError(null);
    setBusy(false);
    if (artwork) {
      setName(typeof artwork.name === 'string' ? artwork.name : '');
      setPrompt(typeof artwork.prompt === 'string' ? artwork.prompt : '');
      const ids = Array.isArray(artwork.reference_image_ids)
        ? artwork.reference_image_ids.map((x) => x?.toString?.() || String(x))
        : [];
      setReferenceIds(ids);
      if (typeof artwork.model === 'string' && IMAGE_MODEL_IDS.has(artwork.model)) {
        setImageModel(artwork.model);
      }
    } else {
      setName('');
      setPrompt('');
      setReferenceIds([]);
    }
  }, [open, artwork]);

  useEffect(() => {
    writeStoredImageModel(MODEL_STORAGE_KEY, imageModel);
  }, [imageModel]);

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }

  const canSubmit = prompt.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const seq = openSeqRef.current;
    try {
      if (isExisting) {
        const artworkId = artwork._id?.toString?.() || String(artwork._id);
        await apiPostJson(`${basePath}/artwork/${artworkId}/regenerate`, {
          prompt: prompt.trim(),
          name: name.trim(),
          model: imageModel,
          reference_image_ids: referenceIds,
        });
      } else {
        await apiPostJson(`${basePath}/artwork`, {
          prompt: prompt.trim(),
          name: name.trim(),
          model: imageModel,
          reference_image_ids: referenceIds,
        });
      }
      if (seq !== openSeqRef.current) return;
      await onDone?.();
      onClose?.();
    } catch (e) {
      if (seq !== openSeqRef.current) return;
      setError(e?.message || 'Generation failed');
    } finally {
      if (seq === openSeqRef.current) setBusy(false);
    }
  }

  const submitLabel = busy
    ? 'Starting…'
    : isExisting
      ? 'Regenerate'
      : 'Generate';
  const title = isExisting ? 'Regenerate artwork' : 'New artwork';

  return (
    <>
      <Modal
        open={open}
        title={title}
        onClose={onClose}
        dismissible={!busy}
        size="fullscreen"
        footer={
          <>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              type="button"
              className="primary"
              onClick={submit}
              disabled={!canSubmit}
            >
              {submitLabel}
            </button>
          </>
        }
      >
        <div className="frame-generate-modal">
          <div className="frame-generate-body">
            <div className="frame-generate-refs">
              <div className="frame-generate-section-header">
                <span className="field-label">Reference images</span>
                <button
                  type="button"
                  className="primary"
                  onClick={() => setPickerOpen(true)}
                  disabled={busy}
                >
                  + Add references
                </button>
              </div>
              <div className="frame-generate-ref-grid">
                {referenceIds.length === 0 ? (
                  <div className="frame-generate-ref-empty">
                    No reference images selected. Add some from this {hostType}
                    {' or any beat to anchor the generation.'}
                  </div>
                ) : (
                  referenceIds.map((id) => (
                    <div className="frame-generate-ref-thumb" key={id}>
                      <img
                        src={thumbUrl(id)}
                        alt="reference"
                        loading="lazy"
                        onClick={() => window.open(imageUrl(id), '_blank', 'noopener')}
                      />
                      <button
                        type="button"
                        className="storyboard-frame-remove"
                        title="Remove reference"
                        onClick={() => removeReference(id)}
                        disabled={busy}
                      >
                        ×
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="frame-generate-prompt">
              <label
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <span className="field-label">Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Short label so you can find this artwork later"
                  disabled={busy}
                  maxLength={200}
                />
              </label>
              <div
                className="frame-generate-section-header"
                style={{ marginTop: 12 }}
              >
                <span className="field-label">Prompt</span>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the artwork. Sent verbatim to the model along with the references."
                disabled={busy}
                className="frame-generate-textarea"
              />
              <span className="frame-generate-help">
                Saved on the artwork so you can revisit and tweak. Sent with{' '}
                {referenceIds.length} reference{' '}
                {referenceIds.length === 1 ? 'image' : 'images'}.
                Generation runs in the background — this dialog closes once the
                job starts; the result appears in the gallery when ready.
              </span>
            </div>
          </div>

          <div className="frame-generate-model-row">
            <span className="field-label">Image model</span>
            <div className="frame-generate-model-options">
              {IMAGE_MODELS.map((m) => (
                <label key={m.id}>
                  <input
                    type="radio"
                    name="artwork-image-model"
                    value={m.id}
                    checked={imageModel === m.id}
                    onChange={() => setImageModel(m.id)}
                    disabled={busy}
                  />
                  {m.label}
                </label>
              ))}
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}
        </div>
      </Modal>
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
        excludeImageId={artwork?.result_image_id}
      />
    </>
  );
}
