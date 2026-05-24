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
  { key: 'artwork', label: 'Artwork' },
  { key: 'library', label: 'Library' },
  { key: 'upload', label: 'Upload' },
  { key: 'generate', label: 'Generate' },
];

const GEN_MODEL_STORAGE_KEY = 'screenplay.picker.genModel';
const VALID_GEN_MODELS = new Set(['gemini', 'openai', 'fal']);
const GEN_MODEL_LABEL = {
  gemini: 'Nano Banana (Gemini)',
  openai: 'OpenAI (gpt-image-2)',
  fal: 'Flux 2 Kontext (fal.ai)',
};
const GEN_MODEL_ORDER = ['gemini', 'openai', 'fal'];

const MODE_TITLES = {
  add_frame: 'Add frame',
  frame_image: 'Replace frame image',
  frame_reference: 'Add references for this frame',
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

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Universal image picker for the storyboard frame pool. Modes:
//   - `mode='add_frame'`: append a new frame to the pool. Single-pick; pick /
//     upload / generate each create a frame and close. Hits
//     /storyboard/:id/frame/{from-id,upload,generate}.
//   - `mode='frame_image'` (+ frameId): replace an existing frame's image.
//     Single-pick; hits /storyboard/:id/frame/:frameId/image/{from-id,upload}.
//     No Generate tab — use the frame's Regenerate action for that.
//   - `mode='frame_reference'` (+ frameId): multi-select editor for that
//     frame's image-gen reference list. Apply commits via
//     /storyboard/:id/frame/:frameId/reference/set.
//   - `onApply(ids)`: ephemeral multi-select — Apply hands the ids back to the
//     caller instead of persisting. Upload/Generate hidden. Used by the inline
//     frame edit dialog for one-shot refs.
export function ReferencePickerModal({
  open,
  onClose,
  sbId,
  beatId,
  charactersInScene,
  currentReferenceIds,
  mode = 'add_frame',
  frameId = null,
  frameCount = null,
  onAttached,
  onApply = null,
}) {
  const ephemeral = !!onApply;
  const isReference = ephemeral || mode === 'frame_reference';
  // The per-frame "This beat" tab uses the frame picker-options feed; the
  // pool-level (add_frame / frame_image) tab uses the plain beat-images feed.
  const useFramePickerOptions = !!frameId && (isReference || ephemeral);
  const frameRefBase =
    frameId && sbId ? `/storyboard/${sbId}/frame/${frameId}/reference` : null;

  const [tab, setTab] = useState('beat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [beatImages, setBeatImages] = useState(null);
  const [framePickerData, setFramePickerData] = useState(null);
  const [characters, setCharacters] = useState(null);
  const [sceneArtworks, setSceneArtworks] = useState(null);
  const [libraryImages, setLibraryImages] = useState(null);
  const [libraryQuery, setLibraryQuery] = useState('');

  const fileInput = useRef(null);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const originalIdsRef = useRef(new Set());

  useEffect(() => {
    if (!open) return;
    setTab('beat');
    setError(null);
    setBeatImages(null);
    setFramePickerData(null);
    setCharacters(null);
    setSceneArtworks(null);
    setLibraryImages(null);
    setLibraryQuery('');
    const baseline = new Set(
      (currentReferenceIds || []).map((id) => id?.toString?.() || String(id)),
    );
    originalIdsRef.current = baseline;
    setSelectedIds(new Set(baseline));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      try {
        if (tab === 'beat' && useFramePickerOptions && sbId && frameId) {
          if (framePickerData === null) {
            const data = await apiGet(
              `/storyboard/${sbId}/frame/${frameId}/picker-options`,
            );
            if (!cancelled) setFramePickerData(data);
          }
        } else if (tab === 'beat' && beatImages === null && beatId) {
          const data = await apiGet(`/beat/${beatId}/images`);
          if (!cancelled) setBeatImages(data.images || []);
        } else if (tab === 'characters' && characters === null && beatId) {
          const data = await apiGet(`/beat/${beatId}/characters`);
          if (!cancelled) setCharacters(data.characters || []);
        } else if (tab === 'artwork' && sceneArtworks === null && beatId) {
          const data = await apiGet(`/beat/${beatId}/scene-artworks`);
          if (!cancelled) setSceneArtworks(data.artworks || []);
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
  }, [
    open,
    tab,
    beatId,
    sbId,
    frameId,
    useFramePickerOptions,
    beatImages,
    framePickerData,
    characters,
    sceneArtworks,
    libraryImages,
  ]);

  function toggle(imageId) {
    const id = String(imageId);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Single-pick modes (add_frame / frame_image) commit on click and close.
  async function pickSingle(imageId) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'frame_image') {
        await apiPostJson(`/storyboard/${sbId}/frame/${frameId}/image/from-id`, {
          image_id: String(imageId),
        });
      } else {
        await apiPostJson(`/storyboard/${sbId}/frame/from-id`, {
          image_id: String(imageId),
        });
      }
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
      if (isReference) {
        const endpoint = frameRefBase;
        const resp = await apiPostMultipart(endpoint, fd);
        const newId = resp?.image?._id ? String(resp.image._id) : null;
        if (newId) {
          originalIdsRef.current = new Set([...originalIdsRef.current, newId]);
          setSelectedIds((prev) => new Set([...prev, newId]));
        }
        await onAttached?.();
      } else if (mode === 'frame_image') {
        await apiPostMultipart(`/storyboard/${sbId}/frame/${frameId}/image/upload`, fd);
        await onAttached?.();
        onClose?.();
      } else {
        await apiPostMultipart(`/storyboard/${sbId}/frame/upload`, fd);
        await onAttached?.();
        onClose?.();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function generateFromPrompt({ prompt, model }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isReference) {
        const resp = await apiPostJson(`${frameRefBase}/generate`, { prompt, model });
        const newId = resp?.image?._id ? String(resp.image._id) : null;
        if (newId) {
          originalIdsRef.current = new Set([...originalIdsRef.current, newId]);
          setSelectedIds((prev) => new Set([...prev, newId]));
        }
        await onAttached?.();
      } else {
        await apiPostJson(`/storyboard/${sbId}/frame/generate`, { prompt, model });
        await onAttached?.();
        onClose?.();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyChanges() {
    if (busy) return;
    if (ephemeral) {
      onApply([...selectedIds]);
      onClose?.();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(`${frameRefBase}/set`, { image_ids: [...selectedIds] });
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

  const diffCount = useMemo(() => {
    if (!isReference) return 0;
    let n = 0;
    for (const id of selectedIds) if (!originalIdsRef.current.has(id)) n++;
    for (const id of originalIdsRef.current) if (!selectedIds.has(id)) n++;
    return n;
  }, [selectedIds, isReference]);

  const noChanges =
    !isReference || setsEqual(selectedIds, originalIdsRef.current);

  const poolFull =
    mode === 'add_frame' && typeof frameCount === 'number' && frameCount >= 6;

  if (!open) return null;

  const title = MODE_TITLES[mode] || 'Add image';
  const onPick = isReference ? toggle : pickSingle;

  const ephemeralLabel =
    selectedIds.size === 0
      ? 'Apply'
      : `Apply (${selectedIds.size} reference${selectedIds.size === 1 ? '' : 's'})`;
  const footer = isReference ? (
    <>
      <button onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button
        className="primary"
        onClick={applyChanges}
        disabled={busy || (!ephemeral && noChanges)}
      >
        {busy
          ? 'Saving…'
          : ephemeral
            ? ephemeralLabel
            : noChanges
              ? 'Apply'
              : `Apply (${diffCount} change${diffCount === 1 ? '' : 's'})`}
      </button>
    </>
  ) : (
    <button onClick={onClose}>Cancel</button>
  );

  // Visible tabs per mode. frame_image has no Generate (use Regenerate);
  // ephemeral hides Upload + Generate (one-shot, no server persistence).
  let visibleTabs = TABS;
  if (ephemeral) {
    visibleTabs = TABS.filter((t) => t.key !== 'upload' && t.key !== 'generate');
  } else if (mode === 'frame_image') {
    visibleTabs = TABS.filter((t) => t.key !== 'generate');
  }

  return (
    <Modal open={open} title={title} onClose={onClose} footer={footer}>
      <div className="ref-picker">
        <div className="ref-picker-tabs" role="tablist">
          {visibleTabs.map((t) => (
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
        {poolFull && (
          <div className="error-banner">
            This storyboard already has the maximum of 6 frames. Remove one
            before adding another.
          </div>
        )}

        <div className="ref-picker-body">
          {tab === 'beat' && useFramePickerOptions ? (
            <FrameBeatTab
              data={framePickerData}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy || poolFull}
              isReference={isReference}
            />
          ) : tab === 'beat' ? (
            <BeatTab
              images={beatImages}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy || poolFull}
              isReference={isReference}
            />
          ) : null}
          {tab === 'characters' && (
            <CharactersTab
              characters={characters}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy || poolFull}
              isReference={isReference}
            />
          )}
          {tab === 'artwork' && (
            <ArtworkTab
              artworks={sceneArtworks}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy || poolFull}
              isReference={isReference}
            />
          )}
          {tab === 'library' && (
            <LibraryTab
              images={filteredLibrary}
              loaded={libraryImages !== null}
              query={libraryQuery}
              onQuery={setLibraryQuery}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy || poolFull}
              isReference={isReference}
            />
          )}
          {tab === 'upload' && (
            <UploadTab
              fileInputRef={fileInput}
              onUpload={uploadFile}
              busy={busy || poolFull}
            />
          )}
          {tab === 'generate' && (
            <GenerateTab onGenerate={generateFromPrompt} busy={busy || poolFull} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function ThumbGrid({ items, selectedIds, onPick, busy, emptyText, isReference }) {
  if (!items.length) {
    return <p className="ref-picker-empty">{emptyText}</p>;
  }
  return (
    <div className="ref-picker-grid">
      {items.map((it) => {
        const id = String(it._id);
        const selected = isReference && selectedIds.has(id);
        const label = stripMd(it.name) || it.filename || '';
        const title = isReference
          ? selected
            ? `${label} — selected (click to remove)`
            : `${label} — click to select`
          : label;
        return (
          <button
            key={id}
            type="button"
            className={
              'ref-picker-thumb' + (selected ? ' is-selected' : '')
            }
            disabled={busy}
            title={title}
            onClick={() => onPick(id)}
          >
            <img src={thumbUrl(id)} alt={label} loading="lazy" />
            {it.badge && (
              <span className="ref-picker-thumb-badge">{it.badge}</span>
            )}
            {selected && (
              <span className="ref-picker-selected" aria-label="Selected">
                ✓
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function BeatTab({ images, selectedIds, onPick, busy, isReference }) {
  if (images === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  return (
    <ThumbGrid
      items={images}
      selectedIds={selectedIds}
      onPick={onPick}
      busy={busy}
      emptyText="No images attached to this beat yet."
      isReference={isReference}
    />
  );
}

// Per-frame variant of the Beat tab. Renders three labelled sections in
// priority order — the storyboard's OTHER frames, beat artwork, beat images —
// deduping image ids across sections so an image never appears twice.
function FrameBeatTab({ data, selectedIds, onPick, busy, isReference }) {
  if (data === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  const seen = new Set();
  const sections = [];

  const otherFrameItems = [];
  for (const f of data.other_frames || []) {
    const id = String(f.image_id);
    if (seen.has(id)) continue;
    seen.add(id);
    otherFrameItems.push({ _id: id, name: f.label, badge: f.label });
  }
  if (otherFrameItems.length) {
    sections.push({ key: 'frames', title: 'Other frames', items: otherFrameItems });
  }

  const artworkItems = [];
  for (const a of data.beat_artwork || []) {
    const id = String(a._id);
    if (seen.has(id)) continue;
    seen.add(id);
    artworkItems.push({ _id: id, name: a.name || 'artwork' });
  }
  if (artworkItems.length) {
    sections.push({ key: 'artwork', title: 'Beat artwork', items: artworkItems });
  }

  const imageItems = [];
  for (const img of data.beat_images || []) {
    const id = String(img._id);
    if (seen.has(id)) continue;
    seen.add(id);
    imageItems.push({ _id: id, name: img.name || img.filename || '' });
  }
  if (imageItems.length) {
    sections.push({ key: 'images', title: 'Beat reference images', items: imageItems });
  }

  if (!sections.length) {
    return (
      <p className="ref-picker-empty">
        No other frames, artwork, or reference images on this beat yet.
      </p>
    );
  }

  return (
    <div className="ref-picker-character-list">
      {sections.map((s) => (
        <section key={s.key} className="ref-picker-character">
          <h3 className="ref-picker-character-name">{s.title}</h3>
          <ThumbGrid
            items={s.items}
            selectedIds={selectedIds}
            onPick={onPick}
            busy={busy}
            emptyText=""
            isReference={isReference}
          />
        </section>
      ))}
    </div>
  );
}

function CharactersTab({ characters, selectedIds, onPick, busy, isReference }) {
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
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy}
              emptyText=""
              isReference={isReference}
            />
          </section>
        );
      })}
    </div>
  );
}

function ArtworkTab({ artworks, selectedIds, onPick, busy, isReference }) {
  if (artworks === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  if (!artworks.length) {
    return (
      <p className="ref-picker-empty">
        No artwork yet for this beat or its characters. Generate some from the
        Artwork tab on a character or beat first.
      </p>
    );
  }

  // Group by owner ("Beat: X" vs "Character: Y"), preserving artworks[] order.
  const groups = new Map();
  for (const a of artworks) {
    const key = `${a.owner_kind}:${a.owner_id}`;
    if (!groups.has(key)) {
      groups.set(key, { label: a.owner_label || a.owner_kind, items: [] });
    }
    const display = stripMd(a.name) || stripMd(a.prompt).slice(0, 80) || 'artwork';
    groups.get(key).items.push({ _id: a.result_image_id, name: display });
  }

  return (
    <div className="ref-picker-character-list">
      {[...groups.entries()].map(([key, g]) => (
        <section key={key} className="ref-picker-character">
          <h3 className="ref-picker-character-name">{g.label}</h3>
          <ThumbGrid
            items={g.items}
            selectedIds={selectedIds}
            onPick={onPick}
            busy={busy}
            emptyText=""
            isReference={isReference}
          />
        </section>
      ))}
    </div>
  );
}

function LibraryTab({
  images,
  loaded,
  query,
  onQuery,
  selectedIds,
  onPick,
  busy,
  isReference,
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
        selectedIds={selectedIds}
        onPick={onPick}
        busy={busy}
        emptyText={query ? 'No matches.' : 'Library is empty.'}
        isReference={isReference}
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
          {GEN_MODEL_ORDER.map((m) => (
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
                name="ref-picker-gen-model"
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
