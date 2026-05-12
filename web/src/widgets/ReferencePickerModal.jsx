import { useEffect, useMemo, useRef, useState } from 'react';
import {
  apiGet,
  apiPostJson,
  apiPostMultipart,
  thumbUrl,
} from '../api.js';
import { Modal } from './Modal.jsx';

const TABS = [
  { key: 'beat', label: 'This beat' },
  { key: 'characters', label: 'Characters' },
  { key: 'library', label: 'Library' },
  { key: 'upload', label: 'Upload' },
];

function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Modal that lets the user attach a reference image to a storyboard from one
// of four sources: this beat's GridFS images, character images for characters
// in the scene, the global library, or a fresh upload.
export function ReferencePickerModal({
  open,
  onClose,
  sbId,
  beatId,
  charactersInScene,
  currentReferenceIds,
  onAttached,
}) {
  const [tab, setTab] = useState('beat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Per-tab data caches; null = not yet loaded, [] = loaded empty.
  const [beatImages, setBeatImages] = useState(null);
  const [characters, setCharacters] = useState(null);
  const [libraryImages, setLibraryImages] = useState(null);
  const [libraryQuery, setLibraryQuery] = useState('');

  const fileInput = useRef(null);

  const attachedSet = useMemo(() => {
    const out = new Set();
    for (const id of currentReferenceIds || []) {
      const s = id?.toString?.() || String(id);
      out.add(s);
    }
    return out;
  }, [currentReferenceIds]);

  useEffect(() => {
    if (!open) return;
    setTab('beat');
    setError(null);
    setBeatImages(null);
    setCharacters(null);
    setLibraryImages(null);
    setLibraryQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      try {
        if (tab === 'beat' && beatImages === null && beatId) {
          const data = await apiGet(`/beat/${beatId}/images`);
          if (!cancelled) setBeatImages(data.images || []);
        } else if (tab === 'characters' && characters === null && beatId) {
          const data = await apiGet(`/beat/${beatId}/characters`);
          if (!cancelled) setCharacters(data.characters || []);
        } else if (tab === 'library' && libraryImages === null) {
          const data = await apiGet('/library');
          if (!cancelled) setLibraryImages(data.images || []);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [open, tab, beatId, beatImages, characters, libraryImages]);

  async function attach(imageId) {
    if (busy) return;
    if (attachedSet.has(String(imageId))) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(`/storyboard/${sbId}/reference/attach`, {
        image_id: String(imageId),
      });
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await apiPostMultipart(`/storyboard/${sbId}/reference`, fd);
      await onAttached?.();
      onClose?.();
    } catch (e) {
      setError(e.message);
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

  return (
    <Modal
      open={open}
      title="Add reference"
      onClose={onClose}
      footer={<button onClick={onClose}>Cancel</button>}
    >
      <div className="ref-picker">
        <div className="ref-picker-tabs" role="tablist">
          {TABS.map((t) => (
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
          {tab === 'beat' && (
            <BeatTab
              images={beatImages}
              attachedSet={attachedSet}
              onPick={attach}
              busy={busy}
            />
          )}
          {tab === 'characters' && (
            <CharactersTab
              characters={characters}
              attachedSet={attachedSet}
              onPick={attach}
              busy={busy}
            />
          )}
          {tab === 'library' && (
            <LibraryTab
              images={filteredLibrary}
              loaded={libraryImages !== null}
              query={libraryQuery}
              onQuery={setLibraryQuery}
              attachedSet={attachedSet}
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
        </div>
      </div>
    </Modal>
  );
}

function ThumbGrid({ items, attachedSet, onPick, busy, emptyText }) {
  if (!items.length) {
    return <p className="ref-picker-empty">{emptyText}</p>;
  }
  return (
    <div className="ref-picker-grid">
      {items.map((it) => {
        const id = String(it._id);
        const added = attachedSet.has(id);
        const label = stripMd(it.name) || it.filename || '';
        return (
          <button
            key={id}
            type="button"
            className={
              'ref-picker-thumb' + (added ? ' is-added' : '')
            }
            disabled={busy || added}
            title={added ? 'Already added' : label}
            onClick={() => onPick(id)}
          >
            <img src={thumbUrl(id)} alt={label} loading="lazy" />
            {added && <span className="ref-picker-added">Added</span>}
          </button>
        );
      })}
    </div>
  );
}

function BeatTab({ images, attachedSet, onPick, busy }) {
  if (images === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  return (
    <ThumbGrid
      items={images}
      attachedSet={attachedSet}
      onPick={onPick}
      busy={busy}
      emptyText="No images attached to this beat yet."
    />
  );
}

function CharactersTab({ characters, attachedSet, onPick, busy }) {
  if (characters === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  if (!characters.length) {
    return (
      <p className="ref-picker-empty">
        No characters resolved for this beat.
      </p>
    );
  }

  // Each character entry from /beat/:id/characters carries main_image_id and
  // sheets[{ _id, name, content_type }]. We render every sheet as a pickable
  // thumb; main_image_id is shown first when present and not already in sheets.
  return (
    <div className="ref-picker-character-list">
      {characters.map((c) => {
        const items = [];
        if (c.main_image_id) {
          items.push({ _id: c.main_image_id, name: `${c.name} (main)` });
        }
        for (const s of c.sheets || []) {
          if (s._id === c.main_image_id) continue;
          items.push({ _id: s._id, name: s.name || c.name });
        }
        if (!items.length) {
          return (
            <section key={c._id} className="ref-picker-character">
              <h3 className="ref-picker-character-name">{c.name}</h3>
              <p className="ref-picker-empty">No images.</p>
            </section>
          );
        }
        return (
          <section key={c._id} className="ref-picker-character">
            <h3 className="ref-picker-character-name">{c.name}</h3>
            <ThumbGrid
              items={items}
              attachedSet={attachedSet}
              onPick={onPick}
              busy={busy}
              emptyText=""
            />
          </section>
        );
      })}
    </div>
  );
}

function LibraryTab({
  images,
  loaded,
  query,
  onQuery,
  attachedSet,
  onPick,
  busy,
}) {
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
        attachedSet={attachedSet}
        onPick={onPick}
        busy={busy}
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
