import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, apiPostMultipart, imageUrl, thumbUrl } from '../api.js';

// Multi-select modal that picks reference images for the Artwork dialog.
// Tabs:
//   "This <host>" — the host's own images[] + its done artworks[] (result_image_id),
//                   plus any images uploaded during this session via the Upload tab.
//   "Beats"       — every beat's images + done artworks, badged with the beat name.
//   "Characters"  — only when hostType === 'beat'; the main image + sheets of every
//                   character resolved for the current beat (via /beat/:id/characters).
//   "Upload"      — file/drop upload that POSTs straight to /<hostType>/<hostId>/image,
//                   adds the new image to the selection, and surfaces it on "This".
// The shared search input filters all browse tabs by name/desc/filename. The
// currently edited image (if any) is filtered out. Selection persists across
// tab switches. The output contract (onApply(ids)) is unchanged from the
// original picker so the existing callers don't need updates.

function stripMd(s) {
  return String(s || '')
    .replace(/[*_`~]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalize a candidate entry from any source (image, artwork, beat ref) to
// `{ id, label, badge, name, description, filename, source_kind }` for
// rendering + filtering.
function candidateFromImage(img, sourceKind, badge) {
  if (!img?._id) return null;
  return {
    id: img._id?.toString?.() || String(img._id),
    label: stripMd(img.name) || img.filename || '(unnamed)',
    badge,
    name: img.name || '',
    description: img.description || '',
    filename: img.filename || '',
    source_kind: sourceKind,
  };
}

function candidateFromArtwork(aw, sourceKind, badge) {
  if (!aw?.result_image_id) return null;
  return {
    id: aw.result_image_id?.toString?.() || String(aw.result_image_id),
    label: stripMd(aw.name) || stripMd(aw.prompt).slice(0, 80) || '(artwork)',
    badge: `${badge} • artwork`,
    name: aw.name || '',
    description: aw.prompt || '',
    filename: '',
    source_kind: sourceKind,
  };
}

function matchesFilter(cand, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    cand.name.toLowerCase().includes(q) ||
    cand.description.toLowerCase().includes(q) ||
    cand.filename.toLowerCase().includes(q) ||
    cand.label.toLowerCase().includes(q)
  );
}

export function ArtworkReferencePicker({
  open,
  onClose,
  onApply,
  hostType = 'character',
  hostLabel,
  hostId,
  hostImages = [],
  hostArtworks = [],
  selectedIds = [],
  excludeImageId = null,
}) {
  const [tab, setTab] = useState('this');
  const [filter, setFilter] = useState('');
  const [working, setWorking] = useState(() => new Set());
  const [beats, setBeats] = useState(null);
  const [beatsError, setBeatsError] = useState(null);
  const [characters, setCharacters] = useState(null);
  const [charactersError, setCharactersError] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [localUploads, setLocalUploads] = useState([]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setWorking(new Set((selectedIds || []).map(String)));
    setFilter('');
    setTab('this');
    setBeats(null);
    setBeatsError(null);
    setCharacters(null);
    setCharactersError(null);
    setUploadBusy(false);
    setUploadError(null);
    setLocalUploads([]);
    // selectedIds intentionally captured at open time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || tab !== 'beats' || beats !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet('/beats/with-artwork');
        if (!cancelled) setBeats(data.beats || []);
      } catch (e) {
        if (!cancelled) setBeatsError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, beats]);

  useEffect(() => {
    if (!open || tab !== 'characters' || characters !== null) return;
    if (hostType !== 'beat' || !hostId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet(`/beat/${hostId}/characters`);
        if (!cancelled) setCharacters(data.characters || []);
      } catch (e) {
        if (!cancelled) setCharactersError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tab, characters, hostType, hostId]);

  // Built candidates per tab. We re-derive on every render — these arrays
  // are small (tens to low hundreds at most) so the cost is negligible.
  const thisHostCandidates = useMemo(() => {
    const out = [];
    const seen = new Set();
    for (const img of hostImages || []) {
      const c = candidateFromImage(img, `host-${hostType}`, hostLabel || 'this');
      if (c) {
        seen.add(c.id);
        out.push(c);
      }
    }
    for (const aw of hostArtworks || []) {
      if (aw.status && aw.status !== 'done') continue;
      const c = candidateFromArtwork(aw, `host-${hostType}-artwork`, hostLabel || 'this');
      if (c) {
        seen.add(c.id);
        out.push(c);
      }
    }
    // Session uploads from the Upload tab. Kept here so the just-uploaded
    // thumb stays visible on "This <host>" even before the parent's
    // hostImages prop refreshes via the Hocuspocus fields_updated broadcast.
    for (const img of localUploads) {
      const c = candidateFromImage(img, `host-${hostType}-upload`, hostLabel || 'this');
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }
    return out;
  }, [hostImages, hostArtworks, hostType, hostLabel, localUploads]);

  const beatCandidates = useMemo(() => {
    if (!beats) return [];
    const out = [];
    for (const b of beats) {
      const beatBadge = b.order ? `Beat ${b.order}` : b.name || 'Beat';
      // Skip the current host if it's a beat — its content is already on
      // the "This beat" tab.
      if (hostType === 'beat' && String(b._id) === String(hostId)) continue;
      for (const img of b.images || []) {
        const c = candidateFromImage(img, 'beat-image', beatBadge);
        if (c) out.push(c);
      }
      for (const aw of b.artworks || []) {
        const c = candidateFromArtwork(aw, 'beat-artwork', beatBadge);
        if (c) out.push(c);
      }
    }
    return out;
  }, [beats, hostType, hostId]);

  // Flat candidate list for the Characters tab, with the originating character
  // id tucked under `character_id` so the JSX can render grouped sections
  // while we still flow through the shared search/exclude pipeline.
  const characterCandidates = useMemo(() => {
    if (!characters) return [];
    const out = [];
    for (const c of characters) {
      const cName = c.name || 'Character';
      const mainId = c.main_image_id ? String(c.main_image_id) : null;
      if (mainId) {
        out.push({
          id: mainId,
          label: `${cName} (main)`,
          badge: cName,
          name: cName,
          description: '',
          filename: '',
          source_kind: 'character-main',
          character_id: String(c._id),
          character_name: cName,
        });
      }
      for (const sheet of c.sheets || []) {
        const sid = sheet?._id ? String(sheet._id) : null;
        if (!sid || sid === mainId) continue;
        out.push({
          id: sid,
          label: sheet.name || `${cName} sheet`,
          badge: cName,
          name: sheet.name || '',
          description: '',
          filename: '',
          source_kind: 'character-sheet',
          character_id: String(c._id),
          character_name: cName,
        });
      }
    }
    return out;
  }, [characters]);

  const filterTokens = filter.trim();

  function filterAndExclude(cands) {
    const ex = excludeImageId ? String(excludeImageId) : null;
    return cands.filter((c) => {
      if (ex && c.id === ex) return false;
      return matchesFilter(c, filterTokens);
    });
  }

  const visibleThis = filterAndExclude(thisHostCandidates);
  const visibleBeats = filterAndExclude(beatCandidates);
  const visibleCharacters = filterAndExclude(characterCandidates);

  // Re-group the filtered Characters candidates back by character so the JSX
  // can render section headers. Preserves character order from the API.
  const groupedCharacters = useMemo(() => {
    if (!characters) return [];
    const visibleByCharacter = new Map();
    for (const cand of visibleCharacters) {
      const arr = visibleByCharacter.get(cand.character_id) || [];
      arr.push(cand);
      visibleByCharacter.set(cand.character_id, arr);
    }
    return characters.map((c) => ({
      _id: String(c._id),
      name: c.name || 'Character',
      candidates: visibleByCharacter.get(String(c._id)) || [],
    }));
  }, [characters, visibleCharacters]);

  function toggle(id) {
    setWorking((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function uploadFile(file) {
    if (!file || uploadBusy) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiPostMultipart(`/${hostType}/${hostId}/image`, fd);
      const newId = res?.image_id ? String(res.image_id) : null;
      if (newId) {
        setLocalUploads((prev) =>
          prev.some((x) => String(x._id) === newId)
            ? prev
            : [...prev, { _id: newId, name: file.name || '', filename: file.name || '' }],
        );
        setWorking((prev) => {
          const next = new Set(prev);
          next.add(newId);
          return next;
        });
      }
    } catch (e) {
      setUploadError(e?.message || 'Upload failed');
    } finally {
      setUploadBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function apply() {
    onApply?.([...working]);
    onClose?.();
  }

  const tabs = [
    { key: 'this', label: hostLabel ? `This ${hostType} (${hostLabel})` : `This ${hostType}` },
    { key: 'beats', label: 'Beats' },
    ...(hostType === 'beat' ? [{ key: 'characters', label: 'Characters' }] : []),
    { key: 'upload', label: 'Upload' },
  ];

  return (
    <Modal
      open={open}
      title="Select reference images"
      onClose={onClose}
      dismissible
      size="wide"
      footer={
        <>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={apply}>
            Apply ({working.size})
          </button>
        </>
      }
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

        {tab !== 'upload' && (
          <input
            type="search"
            className="ref-picker-search"
            placeholder="Filter by name or description…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        )}

        {tab === 'beats' && beatsError && <div className="error-banner">{beatsError}</div>}
        {tab === 'characters' && charactersError && (
          <div className="error-banner">{charactersError}</div>
        )}
        {tab === 'upload' && uploadError && (
          <div className="error-banner">{uploadError}</div>
        )}

        <div className="ref-picker-body">
          {tab === 'this' && (
            <ThumbGridBody
              candidates={visibleThis}
              working={working}
              onToggle={toggle}
              emptyText={
                filterTokens
                  ? 'No matches.'
                  : `Nothing attached to this ${hostType} yet.`
              }
            />
          )}

          {tab === 'beats' && (
            beats === null && !beatsError ? (
              <p className="ref-picker-empty">Loading beats…</p>
            ) : (
              <ThumbGridBody
                candidates={visibleBeats}
                working={working}
                onToggle={toggle}
                emptyText={filterTokens ? 'No matches.' : 'No images on other beats yet.'}
              />
            )
          )}

          {tab === 'characters' && (
            characters === null && !charactersError ? (
              <p className="ref-picker-empty">Loading characters…</p>
            ) : !groupedCharacters.length ? (
              <p className="ref-picker-empty">No characters resolved for this beat.</p>
            ) : (
              <div className="ref-picker-character-list">
                {groupedCharacters.map((g) => (
                  <section key={g._id} className="ref-picker-character">
                    <h3 className="ref-picker-character-name">{g.name}</h3>
                    {g.candidates.length === 0 ? (
                      <p className="ref-picker-empty">
                        {filterTokens ? 'No matches.' : 'No images.'}
                      </p>
                    ) : (
                      <div className="artwork-ref-grid">
                        {g.candidates.map((cand) => {
                          const checked = working.has(cand.id);
                          return (
                            <button
                              key={cand.id}
                              type="button"
                              className={`artwork-ref-thumb${checked ? ' is-selected' : ''}`}
                              onClick={() => toggle(cand.id)}
                              title={cand.label}
                            >
                              <img src={thumbUrl(cand.id)} alt={cand.label} loading="lazy" />
                              <span className="artwork-ref-check">{checked ? '✓' : ''}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            )
          )}

          {tab === 'upload' && (
            <UploadDropZone
              fileInputRef={fileInputRef}
              onUpload={uploadFile}
              busy={uploadBusy}
              hostType={hostType}
              recent={localUploads}
              working={working}
              onToggle={toggle}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

function ThumbGridBody({ candidates, working, onToggle, emptyText }) {
  if (candidates.length === 0) {
    return <p className="ref-picker-empty">{emptyText}</p>;
  }
  return (
    <div className="artwork-ref-grid">
      {candidates.map((cand) => {
        const checked = working.has(cand.id);
        return (
          <button
            key={cand.id}
            type="button"
            className={`artwork-ref-thumb${checked ? ' is-selected' : ''}`}
            onClick={() => onToggle(cand.id)}
            title={cand.label}
          >
            <img src={thumbUrl(cand.id)} alt={cand.label} loading="lazy" />
            {cand.badge && <span className="artwork-ref-badge">{cand.badge}</span>}
            <span className="artwork-ref-check">{checked ? '✓' : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

function UploadDropZone({ fileInputRef, onUpload, busy, hostType, recent, working, onToggle }) {
  const [dragging, setDragging] = useState(false);

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) onUpload(file);
  }

  return (
    <>
      <div
        className={`ref-picker-drop${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
        onDragOver={(e) => {
          if (busy) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>
          Drop an image here to upload it to this {hostType} and select it as a
          reference, or
        </p>
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

      {recent.length > 0 && (
        <div className="ref-picker-upload-recent">
          <div className="field-label" style={{ marginBottom: 6 }}>
            Uploaded this session
          </div>
          <div className="artwork-ref-grid">
            {recent.map((img) => {
              const id = String(img._id);
              const checked = working.has(id);
              const label = img.name || img.filename || 'uploaded image';
              return (
                <button
                  key={id}
                  type="button"
                  className={`artwork-ref-thumb${checked ? ' is-selected' : ''}`}
                  onClick={() => onToggle(id)}
                  title={label}
                >
                  <img src={thumbUrl(id)} alt={label} loading="lazy" />
                  <span className="artwork-ref-check">{checked ? '✓' : ''}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// Re-exports kept so the dialog can render thumbs without re-importing.
export { imageUrl, thumbUrl };
