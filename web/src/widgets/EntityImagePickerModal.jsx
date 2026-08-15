import { useEffect, useMemo, useRef, useState } from 'react';
import {
  apiGet,
  apiPostJson,
  apiPostMultipart,
  thumbUrl,
} from '../api.js';
import { Modal } from './Modal.jsx';
import { ArtworkReferencePicker } from './ArtworkReferencePicker.jsx';
import { ImageModelSelect } from './ImageModelSelect.jsx';
import {
  readStoredCatalogModel,
  writeStoredImageModel,
} from './imageModels.js';

const GEN_MODEL_STORAGE_KEY = 'screenplay.picker.genModel';

function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Picker for entity image galleries (beat, character, set, notes). Tabs:
//   upload     — POST a file to `uploadPath`
//   generate   — text-to-image to `generatePath`, with Gemini/OpenAI choice
//   characters — pick any character's image (copies, doesn't move)
//   beats      — pick any beat's image (copies, doesn't move)
//   sets       — pick any set's image (copies, doesn't move)
//
// Required props:
//   uploadPath           — POST multipart endpoint (e.g. /beat/:id/image)
//   generatePath         — POST {prompt, model} endpoint
//   characterSourcesPath — GET endpoint for character-owned images
//   beatSourcesPath      — GET endpoint for beat-owned images
//   setSourcesPath       — GET endpoint for set-owned images
//   copyPath             — POST {image_id} endpoint that copies a source image
//   onAttached           — async callback after a successful action
//   referenceHost        — optional {hostType, hostId, hostLabel, hostImages,
//                          hostArtworks}; when set, the Generate tab offers a
//                          reference-image picker and reference_image_ids are
//                          sent alongside the prompt
export function EntityImagePickerModal({
  open,
  onClose,
  title = 'Add image',
  uploadPath,
  generatePath,
  characterSourcesPath,
  beatSourcesPath,
  setSourcesPath,
  copyPath,
  onAttached,
  referenceHost = null,
}) {
  const tabs = useMemo(() => {
    const t = [];
    if (uploadPath) t.push({ key: 'upload', label: 'Upload' });
    if (generatePath) t.push({ key: 'generate', label: 'Generate' });
    if (characterSourcesPath && copyPath) t.push({ key: 'characters', label: 'Character' });
    if (beatSourcesPath && copyPath) t.push({ key: 'beats', label: 'Beats' });
    if (setSourcesPath && copyPath) t.push({ key: 'sets', label: 'Sets' });
    return t;
  }, [uploadPath, generatePath, characterSourcesPath, beatSourcesPath, setSourcesPath, copyPath]);

  const [tab, setTab] = useState(tabs[0]?.key || 'upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [characterImages, setCharacterImages] = useState(null);
  const [characterQuery, setCharacterQuery] = useState('');
  const [beatImages, setBeatImages] = useState(null);
  const [beatQuery, setBeatQuery] = useState('');
  const [setImages, setSetImages] = useState(null);
  const [setQuery, setSetQuery] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTab(tabs[0]?.key || 'upload');
    setError(null);
    setCharacterImages(null);
    setCharacterQuery('');
    setBeatImages(null);
    setBeatQuery('');
    setSetImages(null);
    setSetQuery('');
  }, [open, tabs]);

  useEffect(() => {
    if (!open || tab !== 'characters' || characterImages !== null) return;
    if (!characterSourcesPath) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet(characterSourcesPath);
        if (!cancelled) setCharacterImages(data.images || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, characterImages, characterSourcesPath]);

  useEffect(() => {
    if (!open || tab !== 'beats' || beatImages !== null) return;
    if (!beatSourcesPath) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet(beatSourcesPath);
        if (!cancelled) setBeatImages(data.images || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, beatImages, beatSourcesPath]);

  useEffect(() => {
    if (!open || tab !== 'sets' || setImages !== null) return;
    if (!setSourcesPath) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet(setSourcesPath);
        if (!cancelled) setSetImages(data.images || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, setImages, setSourcesPath]);

  async function copy(imageId) {
    if (busy || !copyPath) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(copyPath, { image_id: String(imageId) });
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file) {
    if (!file || busy || !uploadPath) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(uploadPath, fd);
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function generateFromPrompt({ prompt, model, referenceIds }) {
    if (busy || !generatePath) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(generatePath, {
        prompt,
        model,
        ...(referenceIds?.length ? { reference_image_ids: referenceIds } : {}),
      });
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const filteredCharacters = useMemo(() => {
    if (!characterImages) return [];
    const f = characterQuery.trim().toLowerCase();
    if (!f) return characterImages;
    return characterImages.filter((img) => {
      const name = stripMd(img.name).toLowerCase();
      const desc = String(img.description || '').toLowerCase();
      const owner = stripMd(img.owner_name).toLowerCase();
      return name.includes(f) || desc.includes(f) || owner.includes(f);
    });
  }, [characterImages, characterQuery]);

  const filteredBeats = useMemo(() => {
    if (!beatImages) return [];
    const f = beatQuery.trim().toLowerCase();
    if (!f) return beatImages;
    return beatImages.filter((img) => {
      const name = stripMd(img.name).toLowerCase();
      const desc = String(img.description || '').toLowerCase();
      const owner = stripMd(img.owner_name).toLowerCase();
      const order = String(img.owner_order ?? '').toLowerCase();
      return (
        name.includes(f) ||
        desc.includes(f) ||
        owner.includes(f) ||
        order.includes(f)
      );
    });
  }, [beatImages, beatQuery]);

  const filteredSets = useMemo(() => {
    if (!setImages) return [];
    const f = setQuery.trim().toLowerCase();
    if (!f) return setImages;
    return setImages.filter((img) => {
      const name = stripMd(img.name).toLowerCase();
      const desc = String(img.description || '').toLowerCase();
      const owner = stripMd(img.owner_name).toLowerCase();
      return name.includes(f) || desc.includes(f) || owner.includes(f);
    });
  }, [setImages, setQuery]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={<button onClick={onClose}>Cancel</button>}
    >
      <div className="ref-picker">
        <div className="ref-picker-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={
                'ref-picker-tab' + (tab === t.key ? ' is-active' : '')
              }
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="ref-picker-body">
          {tab === 'upload' && (
            <UploadTab
              fileInputRef={fileInput}
              onUpload={uploadFile}
              busy={busy}
            />
          )}
          {tab === 'generate' && (
            <GenerateTab
              onGenerate={generateFromPrompt}
              busy={busy}
              referenceHost={referenceHost}
            />
          )}
          {tab === 'characters' && (
            <SourceTab
              images={filteredCharacters}
              loaded={characterImages !== null}
              query={characterQuery}
              onQuery={setCharacterQuery}
              onPick={copy}
              busy={busy}
              placeholder="Search character name or image…"
              emptyText="No character images."
              labelFor={(it) => stripMd(it.owner_name) || '(unknown character)'}
            />
          )}
          {tab === 'beats' && (
            <SourceTab
              images={filteredBeats}
              loaded={beatImages !== null}
              query={beatQuery}
              onQuery={setBeatQuery}
              onPick={copy}
              busy={busy}
              placeholder="Search beat name, order, or image…"
              emptyText="No beat images."
              labelFor={(it) => {
                const owner = stripMd(it.owner_name);
                if (it.owner_order != null) {
                  return `Beat ${it.owner_order}${owner ? `: ${owner}` : ''}`;
                }
                return owner || '(unknown beat)';
              }}
            />
          )}
          {tab === 'sets' && (
            <SourceTab
              images={filteredSets}
              loaded={setImages !== null}
              query={setQuery}
              onQuery={setSetQuery}
              onPick={copy}
              busy={busy}
              placeholder="Search set name or image…"
              emptyText="No set images."
              labelFor={(it) => stripMd(it.owner_name) || '(unknown set)'}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function SourceTab({
  images,
  loaded,
  query,
  onQuery,
  onPick,
  busy,
  placeholder,
  emptyText,
  labelFor,
}) {
  if (!loaded) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  return (
    <>
      <input
        type="search"
        className="ref-picker-search"
        placeholder={placeholder}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      {images.length === 0 ? (
        <p className="ref-picker-empty">
          {query ? 'No matches.' : emptyText}
        </p>
      ) : (
        <div className="ref-picker-grid">
          {images.map((it) => {
            const id = String(it._id);
            const ownerLabel = labelFor(it);
            const imageLabel = stripMd(it.name) || it.filename || '';
            const title = imageLabel
              ? `${ownerLabel} — ${imageLabel}`
              : ownerLabel;
            return (
              <button
                key={id}
                type="button"
                className="ref-picker-thumb ref-picker-thumb--labeled"
                disabled={busy}
                title={title}
                onClick={() => onPick(id)}
              >
                <img src={thumbUrl(id)} alt={ownerLabel} loading="lazy" />
                <span className="ref-picker-thumb-caption">{ownerLabel}</span>
              </button>
            );
          })}
        </div>
      )}
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
      <p>Drop an image here, or</p>
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

function GenerateTab({ onGenerate, busy, referenceHost }) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(() => readStoredCatalogModel(GEN_MODEL_STORAGE_KEY));
  const [referenceIds, setReferenceIds] = useState([]);
  const [refPickerOpen, setRefPickerOpen] = useState(false);

  useEffect(() => {
    writeStoredImageModel(GEN_MODEL_STORAGE_KEY, model);
  }, [model]);

  const trimmed = prompt.trim();
  const canSubmit = !busy && trimmed.length > 0;

  function submit() {
    if (!canSubmit) return;
    onGenerate({ prompt: trimmed, model, referenceIds });
  }

  function removeReference(id) {
    setReferenceIds((prev) => prev.filter((x) => x !== id));
  }

  return (
    <div className="ref-picker-generate">
      {referenceHost && (
        <div className="frame-generate-refs" style={{ marginBottom: 12 }}>
          <div className="frame-generate-section-header">
            <span className="field-label">Reference images</span>
            <button
              type="button"
              onClick={() => setRefPickerOpen(true)}
              disabled={busy}
            >
              + Add references
            </button>
          </div>
          <div className="frame-generate-ref-grid">
            {referenceIds.length === 0 ? (
              <div className="frame-generate-ref-empty">
                No reference images selected. Optional — they anchor the
                generation.
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
          <ArtworkReferencePicker
            open={refPickerOpen}
            onClose={() => setRefPickerOpen(false)}
            onApply={(ids) => setReferenceIds(ids)}
            hostType={referenceHost.hostType}
            hostId={referenceHost.hostId}
            hostLabel={referenceHost.hostLabel}
            hostImages={referenceHost.hostImages || []}
            hostArtworks={referenceHost.hostArtworks || []}
            selectedIds={referenceIds}
          />
        </div>
      )}
      <label
        style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <span className="field-label">Prompt</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          placeholder='e.g. "wide shot, neon-lit alley at night, rain on cobblestones"'
          disabled={busy}
        />
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          {referenceIds.length
            ? 'Sent verbatim to the image model along with the selected references.'
            : 'Sent verbatim to the image model. No scene context.'}
        </span>
      </label>

      <div style={{ marginTop: 12 }}>
        <span className="field-label">Image model</span>
        <ImageModelSelect
          value={model}
          onChange={setModel}
          disabled={busy}
          compact
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <button
          type="button"
          className="primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </div>
  );
}
