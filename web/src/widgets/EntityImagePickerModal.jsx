import { useEffect, useMemo, useRef, useState } from 'react';
import {
  apiGet,
  apiPostJson,
  apiPostMultipart,
  thumbUrl,
} from '../api.js';
import { Modal } from './Modal.jsx';
import {
  IMAGE_MODELS,
  readStoredImageModel,
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

// Picker for entity image galleries (beat, character, notes). Tabs:
//   library    — pick from the global library (re-parents the image)
//   upload     — POST a file to `uploadPath`
//   generate   — text-to-image to `generatePath`, with Gemini/OpenAI choice
//   characters — pick any character's image (copies, doesn't move)
//   beats      — pick any beat's image (copies, doesn't move)
//
// Required props:
//   uploadPath           — POST multipart endpoint (e.g. /beat/:id/image)
//   attachPath           — POST {image_id} endpoint (e.g. /beat/:id/image/attach)
//   generatePath         — POST {prompt, model} endpoint
//   characterSourcesPath — GET endpoint for character-owned images
//   beatSourcesPath      — GET endpoint for beat-owned images
//   copyPath             — POST {image_id} endpoint that copies a source image
//   onAttached           — async callback after a successful action
export function EntityImagePickerModal({
  open,
  onClose,
  title = 'Add image',
  uploadPath,
  attachPath,
  generatePath,
  characterSourcesPath,
  beatSourcesPath,
  copyPath,
  onAttached,
}) {
  const tabs = useMemo(() => {
    const t = [];
    if (attachPath) t.push({ key: 'library', label: 'Library' });
    if (uploadPath) t.push({ key: 'upload', label: 'Upload' });
    if (generatePath) t.push({ key: 'generate', label: 'Generate' });
    if (characterSourcesPath && copyPath) t.push({ key: 'characters', label: 'Character' });
    if (beatSourcesPath && copyPath) t.push({ key: 'beats', label: 'Beats' });
    return t;
  }, [attachPath, uploadPath, generatePath, characterSourcesPath, beatSourcesPath, copyPath]);

  const [tab, setTab] = useState(tabs[0]?.key || 'upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [libraryImages, setLibraryImages] = useState(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [characterImages, setCharacterImages] = useState(null);
  const [characterQuery, setCharacterQuery] = useState('');
  const [beatImages, setBeatImages] = useState(null);
  const [beatQuery, setBeatQuery] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTab(tabs[0]?.key || 'upload');
    setError(null);
    setLibraryImages(null);
    setLibraryQuery('');
    setCharacterImages(null);
    setCharacterQuery('');
    setBeatImages(null);
    setBeatQuery('');
  }, [open, tabs]);

  useEffect(() => {
    if (!open || tab !== 'library' || libraryImages !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet('/library');
        if (!cancelled) setLibraryImages(data.images || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, libraryImages]);

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

  async function attach(imageId) {
    if (busy || !attachPath) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(attachPath, { image_id: String(imageId) });
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

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

  async function generateFromPrompt({ prompt, model }) {
    if (busy || !generatePath) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(generatePath, { prompt, model });
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
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
          {tab === 'library' && (
            <LibraryTab
              images={filteredLibrary}
              loaded={libraryImages !== null}
              query={libraryQuery}
              onQuery={setLibraryQuery}
              onPick={attach}
              busy={busy}
            />
          )}
          {tab === 'upload' && (
            <UploadTab
              fileInputRef={fileInput}
              onUpload={uploadFile}
              busy={busy}
            />
          )}
          {tab === 'generate' && (
            <GenerateTab onGenerate={generateFromPrompt} busy={busy} />
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
        </div>
      </div>
    </Modal>
  );
}

function LibraryTab({ images, loaded, query, onQuery, onPick, busy }) {
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
      {images.length === 0 ? (
        <p className="ref-picker-empty">
          {query ? 'No matches.' : 'Library is empty.'}
        </p>
      ) : (
        <div className="ref-picker-grid">
          {images.map((it) => {
            const id = String(it._id);
            const label = stripMd(it.name) || it.filename || '';
            return (
              <button
                key={id}
                type="button"
                className="ref-picker-thumb"
                disabled={busy}
                title={label}
                onClick={() => onPick(id)}
              >
                <img src={thumbUrl(id)} alt={label} loading="lazy" />
              </button>
            );
          })}
        </div>
      )}
    </>
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

function GenerateTab({ onGenerate, busy }) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(() => readStoredImageModel(GEN_MODEL_STORAGE_KEY));

  useEffect(() => {
    writeStoredImageModel(GEN_MODEL_STORAGE_KEY, model);
  }, [model]);

  const trimmed = prompt.trim();
  const canSubmit = !busy && trimmed.length > 0;

  function submit() {
    if (!canSubmit) return;
    onGenerate({ prompt: trimmed, model });
  }

  return (
    <div className="ref-picker-generate">
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
          Sent verbatim to the image model. No scene context or references.
        </span>
      </label>

      <div style={{ marginTop: 12 }}>
        <span className="field-label">Image model</span>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            marginTop: 6,
          }}
        >
          {IMAGE_MODELS.map((m) => (
            <label
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
              }}
            >
              <input
                type="radio"
                name="entity-img-picker-model"
                value={m.id}
                checked={model === m.id}
                onChange={() => setModel(m.id)}
                disabled={busy}
              />
              {m.label}
            </label>
          ))}
        </div>
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
