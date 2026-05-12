import { useEffect, useMemo, useRef, useState } from 'react';
import {
  apiGet,
  apiPostJson,
  apiPostMultipart,
  thumbUrl,
} from '../api.js';
import { Modal } from './Modal.jsx';

const GEN_MODEL_STORAGE_KEY = 'screenplay.picker.genModel';
const VALID_GEN_MODELS = new Set(['gemini', 'openai']);
const GEN_MODEL_LABEL = {
  gemini: 'Nano Banana (Gemini)',
  openai: 'OpenAI (gpt-image-2)',
};

function readStoredGenModel() {
  try {
    const v = localStorage.getItem(GEN_MODEL_STORAGE_KEY);
    return VALID_GEN_MODELS.has(v) ? v : 'gemini';
  } catch {
    return 'gemini';
  }
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

// Picker for entity image galleries (beat, character, notes). Three tabs:
//   library  — pick from the global library (re-parents the image)
//   upload   — POST a file to `uploadPath`
//   generate — text-to-image to `generatePath`, with Gemini/OpenAI choice
//
// Required props:
//   uploadPath   — POST multipart endpoint (e.g. /beat/:id/image)
//   attachPath   — POST {image_id} endpoint (e.g. /beat/:id/image/attach)
//   generatePath — POST {prompt, model} endpoint
//   onAttached   — async callback after a successful action
export function EntityImagePickerModal({
  open,
  onClose,
  title = 'Add image',
  uploadPath,
  attachPath,
  generatePath,
  onAttached,
}) {
  const tabs = useMemo(() => {
    const t = [];
    if (attachPath) t.push({ key: 'library', label: 'Library' });
    if (uploadPath) t.push({ key: 'upload', label: 'Upload' });
    if (generatePath) t.push({ key: 'generate', label: 'Generate' });
    return t;
  }, [attachPath, uploadPath, generatePath]);

  const [tab, setTab] = useState(tabs[0]?.key || 'upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [libraryImages, setLibraryImages] = useState(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    if (!open) return;
    setTab(tabs[0]?.key || 'upload');
    setError(null);
    setLibraryImages(null);
    setLibraryQuery('');
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
  const [model, setModel] = useState(readStoredGenModel);

  useEffect(() => {
    try {
      localStorage.setItem(GEN_MODEL_STORAGE_KEY, model);
    } catch {}
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
          {['gemini', 'openai'].map((m) => (
            <label
              key={m}
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
                value={m}
                checked={model === m}
                onChange={() => setModel(m)}
                disabled={busy}
              />
              {GEN_MODEL_LABEL[m]}
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
