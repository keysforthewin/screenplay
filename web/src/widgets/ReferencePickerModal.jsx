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

const ROLE_TITLES = {
  reference: 'Add references',
  start_frame: 'Set start frame',
  end_frame: 'Set end frame',
};

const FRAME_ROLE_TITLES = {
  start_frame: "Add references for the start frame",
  end_frame: "Add references for the end frame",
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

// Universal image picker for storyboard image fields. Five tabs:
//   beat / characters / library — pick existing GridFS images
//   upload   — upload a file
//   generate — text-to-image with model choice (Gemini / OpenAI / Flux)
//
// Modes:
//   - `role='reference'` (default, no frameRole): legacy row-level reference
//     editor. Multi-select diff editor; Apply commits the final list via
//     /storyboard/:id/reference/set.
//   - `role='start_frame'` | `role='end_frame'`: single-image installer —
//     picking commits to that frame slot immediately.
//   - `frameRole='start_frame'` | `frameRole='end_frame'`: per-frame
//     multi-select reference editor (mirrors the legacy multi-select but
//     scoped to start_frame_reference_ids or end_frame_reference_ids).
export function ReferencePickerModal({
  open,
  onClose,
  sbId,
  beatId,
  charactersInScene,
  currentReferenceIds,
  role = 'reference',
  frameRole = null,
  onAttached,
}) {
  // The picker is in multi-select / reference-list mode either via role='reference'
  // (legacy row-level list) or via frameRole (per-frame list).
  const isReference = role === 'reference' || !!frameRole;
  const frameRefBase =
    frameRole && sbId
      ? `/storyboard/${sbId}/frame/${frameRole}/reference`
      : null;
  const [tab, setTab] = useState('beat');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Per-tab data caches; null = not yet loaded, [] = loaded empty.
  const [beatImages, setBeatImages] = useState(null);
  const [framePickerData, setFramePickerData] = useState(null);
  const [characters, setCharacters] = useState(null);
  const [sceneArtworks, setSceneArtworks] = useState(null);
  const [libraryImages, setLibraryImages] = useState(null);
  const [libraryQuery, setLibraryQuery] = useState('');

  const fileInput = useRef(null);

  // Multi-select state for the reference role. Single-image roles bypass this
  // entirely — they pick-and-commit on click.
  //
  // selectedIds: the working set the user is building; toggles update it.
  // originalIdsRef: snapshot of currentReferenceIds at open time, frozen so
  //   the diff (and the changes count on the Apply button) stays stable even
  //   if a websocket update changes currentReferenceIds mid-session.
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
    // currentReferenceIds intentionally excluded from deps: we snapshot once
    // at open and ignore later prop changes. Apply's replace overwrites
    // whatever the server has on commit (last-writer-wins).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      try {
        if (tab === 'beat' && frameRole && sbId) {
          if (framePickerData === null) {
            const data = await apiGet(
              `/storyboard/${sbId}/frame/${frameRole}/picker-options`,
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
    frameRole,
    beatImages,
    framePickerData,
    characters,
    sceneArtworks,
    libraryImages,
  ]);

  // Toggle an id in the selection set (reference role only).
  function toggle(imageId) {
    const id = String(imageId);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Single-image roles (start_frame / end_frame / character_sheet) commit on
  // click and close — same as before. Only the reference role uses the
  // multi-select / Apply flow.
  async function pickSingle(imageId) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPostJson(`/storyboard/${sbId}/image/from-id`, {
        role,
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

  // Upload tab is immediate-action even in reference mode: it creates a new
  // GridFS image and attaches it server-side. After success, we fold the new
  // id into BOTH the working set AND the baseline so it's preserved when the
  // user clicks Apply (replace mode would otherwise drop it).
  async function uploadFile(file) {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isReference) {
        const fd = new FormData();
        fd.append('file', file);
        const endpoint = frameRefBase || `/storyboard/${sbId}/reference`;
        const resp = await apiPostMultipart(endpoint, fd);
        const newId = resp?.image?._id ? String(resp.image._id) : null;
        if (newId) {
          originalIdsRef.current = new Set([...originalIdsRef.current, newId]);
          setSelectedIds((prev) => new Set([...prev, newId]));
        }
        await onAttached?.();
      } else {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('role', role);
        await apiPostMultipart(`/storyboard/${sbId}/image`, fd);
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

  // Generate tab: same immediate-action pattern as upload.
  async function generateFromPrompt({ prompt, model }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isReference) {
        const endpoint = frameRefBase
          ? `${frameRefBase}/generate`
          : `/storyboard/${sbId}/reference/generate`;
        const resp = await apiPostJson(endpoint, { prompt, model });
        const newId = resp?.image?._id ? String(resp.image._id) : null;
        if (newId) {
          originalIdsRef.current = new Set([...originalIdsRef.current, newId]);
          setSelectedIds((prev) => new Set([...prev, newId]));
        }
        await onAttached?.();
      } else {
        await apiPostJson(`/storyboard/${sbId}/image/generate`, {
          role,
          prompt,
          model,
        });
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
    setBusy(true);
    setError(null);
    try {
      const endpoint = frameRefBase
        ? `${frameRefBase}/set`
        : `/storyboard/${sbId}/reference/set`;
      await apiPostJson(endpoint, {
        image_ids: [...selectedIds],
      });
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

  if (!open) return null;

  const title = frameRole
    ? FRAME_ROLE_TITLES[frameRole] || 'Add references'
    : ROLE_TITLES[role] || 'Add image';
  const onPick = isReference ? toggle : pickSingle;

  const footer = isReference ? (
    <>
      <button onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button
        className="primary"
        onClick={applyChanges}
        disabled={busy || noChanges}
      >
        {busy
          ? 'Saving…'
          : noChanges
            ? 'Apply'
            : `Apply (${diffCount} change${diffCount === 1 ? '' : 's'})`}
      </button>
    </>
  ) : (
    <button onClick={onClose}>Cancel</button>
  );

  return (
    <Modal open={open} title={title} onClose={onClose} footer={footer}>
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
          {tab === 'beat' && frameRole && sbId ? (
            <FrameBeatTab
              data={framePickerData}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy}
              isReference={isReference}
            />
          ) : tab === 'beat' ? (
            <BeatTab
              images={beatImages}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy}
              isReference={isReference}
            />
          ) : null}
          {tab === 'characters' && (
            <CharactersTab
              characters={characters}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy}
              isReference={isReference}
            />
          )}
          {tab === 'artwork' && (
            <ArtworkTab
              artworks={sceneArtworks}
              selectedIds={selectedIds}
              onPick={onPick}
              busy={busy}
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
              busy={busy}
              isReference={isReference}
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
// priority order — sibling frame, beat artwork, beat images — and dedupes
// image ids across sections so a single image never appears twice. The
// sibling frame thumb carries a "Start frame"/"End frame" badge so the user
// can identify it at a glance.
function FrameBeatTab({ data, selectedIds, onPick, busy, isReference }) {
  if (data === null) {
    return <p className="ref-picker-empty">Loading…</p>;
  }
  const seen = new Set();
  const sections = [];

  if (data.sibling_frame?.image_id) {
    const sid = String(data.sibling_frame.image_id);
    seen.add(sid);
    sections.push({
      key: 'sibling',
      title: data.sibling_frame.label,
      items: [
        {
          _id: sid,
          name: data.sibling_frame.label,
          badge: data.sibling_frame.label,
        },
      ],
    });
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
        No sibling frame, artwork, or reference images on this beat yet.
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

  // Group by owner so the user can scan "Beat: X" vs "Character: Y" sections.
  // Order in artworks[] (beat-first, then character-by-character) is already
  // the order we want to render in, so we preserve it with a Map.
  const groups = new Map(); // owner_id → { label, items[] }
  for (const a of artworks) {
    const key = `${a.owner_kind}:${a.owner_id}`;
    if (!groups.has(key)) {
      groups.set(key, { label: a.owner_label || a.owner_kind, items: [] });
    }
    // ThumbGrid uses item._id to pick — for artwork we want to pick the
    // result_image_id (the actual GridFS image), not the artwork's _id.
    const display = stripMd(a.name) || stripMd(a.prompt).slice(0, 80) || 'artwork';
    groups.get(key).items.push({
      _id: a.result_image_id,
      name: display,
    });
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
