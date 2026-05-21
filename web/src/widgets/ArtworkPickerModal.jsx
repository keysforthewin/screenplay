import { useEffect, useMemo, useRef, useState } from 'react';
import {
  apiGet,
  apiPostJson,
  apiPostMultipart,
  thumbUrl,
} from '../api.js';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import {
  IMAGE_MODELS,
  readStoredImageModel,
  writeStoredImageModel,
} from './imageModels.js';

const MODEL_STORAGE_KEY = 'screenplay.artwork.model';

// Tabbed "+ New artwork" dialog. Click any thumb in the non-Generate tabs
// to import that image as a brand-new done artwork on the host (POST
// /:hostType/:hostId/artwork/from-image). The Generate tab keeps the
// original prompt + name + model + nested reference picker flow.
//
// Tab structure varies by host:
//   Beat host:      existing | refs | characters (in beat) | library | upload | generate
//   Character host: existing | refs | beats (featuring this char) | library | upload | generate
export function ArtworkPickerModal({
  open,
  onClose,
  onDone,
  hostType,
  hostId,
  hostLabel,
  hostImages = [],
  hostArtworks = [],
}) {
  const basePath = `/${hostType}/${hostId}`;

  const tabs = useMemo(() => buildTabs(hostType), [hostType]);
  const initialTab = useMemo(() => {
    return (hostArtworks || []).some((a) => a.status === 'done')
      ? 'existing'
      : 'refs';
  }, [hostArtworks]);

  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [related, setRelated] = useState(null);
  const [libraryImages, setLibraryImages] = useState(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setBusy(false);
    setError(null);
    setRelated(null);
    setLibraryImages(null);
    setLibraryQuery('');
  }, [open, initialTab]);

  // Lazy-load related (characters in beat / beats featuring character) and
  // library on first visit to those tabs.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        if (tab === 'related' && related === null) {
          if (hostType === 'beat') {
            const data = await apiGet(`/beat/${hostId}/characters`);
            if (!cancelled) setRelated({ kind: 'characters', items: data.characters || [] });
          } else {
            const data = await apiGet(
              `/beats-featuring-character?character_id=${hostId}`,
            );
            if (!cancelled) setRelated({ kind: 'beats', items: data.beats || [] });
          }
        } else if (tab === 'library' && libraryImages === null) {
          const data = await apiGet('/library');
          if (!cancelled) setLibraryImages(data.images || []);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, hostType, hostId, related, libraryImages]);

  async function importFromImage(imageId) {
    if (busy || !imageId) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(`${basePath}/artwork/from-image`, {
        image_id: String(imageId),
      });
      await onDone?.();
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  async function importFromUpload(file) {
    if (busy || !file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(`${basePath}/artwork/from-upload`, fd);
      await onDone?.();
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Upload failed');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const filteredLibrary = useMemo(() => {
    if (!libraryImages) return [];
    const f = libraryQuery.trim().toLowerCase();
    if (!f) return libraryImages;
    return libraryImages.filter((img) => {
      const name = stripMd(img.name).toLowerCase();
      const desc = String(img.description || '').toLowerCase();
      return name.includes(f) || desc.includes(f);
    });
  }, [libraryImages, libraryQuery]);

  if (!open) return null;

  const isGenerate = tab === 'generate';
  const footer = isGenerate ? null : (
    <button type="button" onClick={onClose} disabled={busy}>
      Cancel
    </button>
  );

  return (
    <Modal
      open={open}
      title="New artwork"
      onClose={onClose}
      dismissible={!busy}
      size="fullscreen"
      footer={footer}
    >
      <div className="ref-picker">
        <div className="ref-picker-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={'ref-picker-tab' + (tab === t.key ? ' is-active' : '')}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="ref-picker-body">
          {tab === 'existing' && (
            <ExistingArtworkTab
              artworks={hostArtworks}
              busy={busy}
              onPick={importFromImage}
            />
          )}
          {tab === 'refs' && (
            <RefsTab
              hostType={hostType}
              hostLabel={hostLabel}
              images={hostImages}
              busy={busy}
              onPick={importFromImage}
            />
          )}
          {tab === 'related' && (
            <RelatedTab
              hostType={hostType}
              data={related}
              busy={busy}
              onPick={importFromImage}
            />
          )}
          {tab === 'library' && (
            <LibraryTab
              loaded={libraryImages !== null}
              images={filteredLibrary}
              query={libraryQuery}
              onQuery={setLibraryQuery}
              busy={busy}
              onPick={importFromImage}
            />
          )}
          {tab === 'upload' && (
            <UploadTab
              fileInputRef={fileInput}
              onUpload={importFromUpload}
              busy={busy}
            />
          )}
          {tab === 'generate' && (
            <GenerateArtworkTab
              hostType={hostType}
              hostId={hostId}
              hostLabel={hostLabel}
              hostImages={hostImages}
              hostArtworks={hostArtworks}
              onDone={onDone}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function buildTabs(hostType) {
  const related = hostType === 'beat'
    ? { key: 'related', label: 'Characters' }
    : { key: 'related', label: 'Beats' };
  return [
    { key: 'existing', label: 'Existing artwork' },
    { key: 'refs', label: 'Reference images' },
    related,
    { key: 'library', label: 'Library' },
    { key: 'upload', label: 'Upload' },
    { key: 'generate', label: 'Generate' },
  ];
}

function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ThumbGrid({ items, onPick, busy, emptyText }) {
  if (!items.length) {
    return <p className="ref-picker-empty">{emptyText}</p>;
  }
  return (
    <div className="ref-picker-grid">
      {items.map((it) => {
        const id = String(it._id);
        const label = stripMd(it.name) || it.filename || '';
        return (
          <button
            key={id}
            type="button"
            className="ref-picker-thumb"
            disabled={busy}
            title={`${label} — click to import as artwork`}
            onClick={() => onPick(id)}
          >
            <img src={thumbUrl(id)} alt={label} loading="lazy" />
            {it.badge && (
              <span className="ref-picker-thumb-badge">{it.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ExistingArtworkTab({ artworks, busy, onPick }) {
  const done = (artworks || []).filter(
    (a) => a.status === 'done' && a.result_image_id,
  );
  const items = done.map((a) => ({
    _id: a.result_image_id?.toString?.() || String(a.result_image_id),
    name: stripMd(a.name) || stripMd(a.prompt).slice(0, 80) || 'artwork',
  }));
  return (
    <ThumbGrid
      items={items}
      busy={busy}
      onPick={onPick}
      emptyText="No artwork yet. Use Generate to create one."
    />
  );
}

function RefsTab({ hostType, hostLabel, images, busy, onPick }) {
  const items = (images || []).map((img) => ({
    _id: img._id?.toString?.() || String(img._id),
    name: stripMd(img.name) || img.filename || '',
  }));
  const empty = `No reference images on this ${hostLabel || hostType} yet.`;
  return (
    <ThumbGrid items={items} busy={busy} onPick={onPick} emptyText={empty} />
  );
}

function RelatedTab({ hostType, data, busy, onPick }) {
  if (data === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  if (!data.items.length) {
    return (
      <p className="ref-picker-empty">
        {hostType === 'beat'
          ? 'No characters resolved for this beat.'
          : 'This character does not appear in any beat yet.'}
      </p>
    );
  }
  if (data.kind === 'characters') {
    return (
      <div className="ref-picker-character-list">
        {data.items.map((c) => {
          const items = [];
          if (c.main_image_id) {
            items.push({ _id: c.main_image_id, name: `${c.name} (main)` });
          }
          for (const s of c.sheets || []) {
            if (s._id === c.main_image_id) continue;
            items.push({ _id: s._id, name: s.name || c.name });
          }
          return (
            <section key={c._id} className="ref-picker-character">
              <h3 className="ref-picker-character-name">{c.name}</h3>
              {items.length ? (
                <ThumbGrid
                  items={items}
                  busy={busy}
                  onPick={onPick}
                  emptyText=""
                />
              ) : (
                <p className="ref-picker-empty">No images.</p>
              )}
            </section>
          );
        })}
      </div>
    );
  }
  // data.kind === 'beats'
  return (
    <div className="ref-picker-character-list">
      {data.items.map((b) => {
        const items = [];
        for (const img of b.images || []) {
          items.push({ _id: img._id, name: img.name || img.filename || '' });
        }
        for (const a of b.artworks || []) {
          if (!a.result_image_id) continue;
          items.push({
            _id: a.result_image_id,
            name: stripMd(a.name) || stripMd(a.prompt).slice(0, 80) || 'artwork',
            badge: 'artwork',
          });
        }
        const title = b.order ? `Beat ${b.order}` : b.name || 'Beat';
        return (
          <section key={b._id} className="ref-picker-character">
            <h3 className="ref-picker-character-name">{title}</h3>
            {items.length ? (
              <ThumbGrid
                items={items}
                busy={busy}
                onPick={onPick}
                emptyText=""
              />
            ) : (
              <p className="ref-picker-empty">No images or artwork.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LibraryTab({ loaded, images, query, onQuery, busy, onPick }) {
  if (!loaded) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  return (
    <>
      <input
        type="search"
        className="ref-picker-search"
        placeholder="Search library…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      <ThumbGrid
        items={images}
        busy={busy}
        onPick={onPick}
        emptyText={query ? 'No matches.' : 'Library is empty.'}
      />
    </>
  );
}

function UploadTab({ fileInputRef, onUpload, busy }) {
  const [dragging, setDragging] = useState(false);

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) onUpload(file);
  }

  return (
    <div
      className={'ref-picker-drop' + (dragging ? ' is-dragging' : '')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <p>Drop an image here to import as artwork, or</p>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
      >
        {busy ? 'Uploading…' : 'Choose file'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
        }}
      />
    </div>
  );
}

// Generate tab — mirrors the body of ArtworkDialog (the existing new-artwork
// form). Prompt + name + image model + nested ArtworkReferencePicker for
// selecting reference images. Submit POSTs to /:hostType/:hostId/artwork
// which returns a pending artwork; the SPA polls via fields_updated.
function GenerateArtworkTab({
  hostType,
  hostId,
  hostLabel,
  hostImages,
  hostArtworks,
  onDone,
  onClose,
}) {
  const [imageModel, setImageModel] = useState(() =>
    readStoredImageModel(MODEL_STORAGE_KEY),
  );
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [referenceIds, setReferenceIds] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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
    try {
      await apiPostJson(`/${hostType}/${hostId}/artwork`, {
        prompt: prompt.trim(),
        name: name.trim(),
        model: imageModel,
        reference_image_ids: referenceIds,
      });
      await onDone?.();
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Generation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
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
                  <img src={thumbUrl(id)} alt="reference" loading="lazy" />
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
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                name="artwork-picker-image-model"
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

      <div
        className="modal-footer"
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          marginTop: 12,
        }}
      >
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={submit}
          disabled={!canSubmit}
        >
          {busy ? 'Starting…' : 'Generate'}
        </button>
      </div>

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
      />
    </div>
  );
}
