import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, thumbUrl } from '../api.js';
import { computeOwners } from './sheetReferenceOwners.js';

// Restricted reference picker for the image-sheet flows (Create image sheet /
// Tune image sheet). Unlike ArtworkReferencePicker there is no Library /
// Upload / Beats browsing — the only sources offered are the entities that
// can legitimately anchor a sheet:
//   set host       — one tab per set staged by the checked beats (this set first;
//                    the dialog passes the currently selected main + context
//                    beat ids via `beatIds`)
//   character host — one tab per character sharing at least one beat with this
//                    character (this character first)
//   beat host      — one tab per set referenced by the beat (Tune image sheet)
// Tab contents come from /images/by-owner/{sets|characters}, which lists every
// GridFS image owned by those entities — uploads, artwork results, and prior
// sheet images alike. The output contract (onApply(ids)) matches
// ArtworkReferencePicker so callers only swap the component.

function matchesFilter(img, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (img.name || '').toLowerCase().includes(q) ||
    (img.description || '').toLowerCase().includes(q) ||
    (img.filename || '').toLowerCase().includes(q)
  );
}

export function SheetReferencePicker({
  open,
  onClose,
  onApply,
  hostType = 'character', // 'character' | 'set' | 'beat'
  hostId,
  hostLabel,
  beatIds = [], // set hosts only: the checked main + context beat ids
  selectedIds = [],
}) {
  const [toc, setToc] = useState(null);
  const [images, setImages] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(null);
  const [filter, setFilter] = useState('');
  const [working, setWorking] = useState(() => new Set());

  const ownerNoun = hostType === 'character' ? 'character' : 'set';

  useEffect(() => {
    if (!open) return;
    setWorking(new Set((selectedIds || []).map(String)));
    setFilter('');
    setTab(null);
    setToc(null);
    setImages(null);
    setError(null);
    let cancelled = false;
    (async () => {
      try {
        const [tocRes, imgRes] = await Promise.all([
          apiGet('/toc'),
          apiGet(`/images/by-owner/${ownerNoun}s`),
        ]);
        if (cancelled) return;
        setToc(tocRes || {});
        setImages(Array.isArray(imgRes?.images) ? imgRes.images : []);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Could not load reference sources');
      }
    })();
    return () => {
      cancelled = true;
    };
    // selectedIds intentionally captured at open time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ownerNoun]);

  const owners = useMemo(() => {
    if (!toc) return null;
    return computeOwners({ hostType, hostId, hostLabel, beatIds, toc });
  }, [toc, hostType, hostId, hostLabel, beatIds]);

  const imagesByOwner = useMemo(() => {
    const map = new Map();
    for (const img of images || []) {
      const key = img.owner_id ? String(img.owner_id) : null;
      if (!key) continue;
      const list = map.get(key) || [];
      list.push(img);
      map.set(key, list);
    }
    return map;
  }, [images]);

  const activeTab = tab || owners?.[0]?.id || null;
  const activeImages = useMemo(() => {
    if (!activeTab) return [];
    const list = imagesByOwner.get(activeTab) || [];
    const q = filter.trim();
    return list.filter((img) => matchesFilter(img, q));
  }, [activeTab, imagesByOwner, filter]);

  function toggle(id) {
    setWorking((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function apply() {
    onApply?.([...working]);
    onClose?.();
  }

  const loading = !error && (owners === null || images === null);
  const filterTokens = filter.trim();

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
        {error && <div className="error-banner">{error}</div>}

        {loading && <p className="ref-picker-empty">Loading {ownerNoun}s…</p>}

        {!loading && !error && owners && owners.length === 0 && (
          <p className="ref-picker-empty">
            No {ownerNoun}s referenced by this beat yet.
          </p>
        )}

        {!loading && !error && owners && owners.length > 0 && (
          <>
            <div className="ref-picker-tabs" role="tablist">
              {owners.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === o.id}
                  className={'ref-picker-tab' + (activeTab === o.id ? ' is-active' : '')}
                  onClick={() => setTab(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <input
              type="search"
              className="ref-picker-search"
              placeholder="Filter by name or description…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />

            <div className="ref-picker-body">
              {activeImages.length === 0 ? (
                <p className="ref-picker-empty">
                  {filterTokens ? 'No matches.' : `No images on this ${ownerNoun} yet.`}
                </p>
              ) : (
                <div className="artwork-ref-grid">
                  {activeImages.map((img) => {
                    const id = String(img._id);
                    const checked = working.has(id);
                    const label = img.name || img.filename || '(unnamed)';
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`artwork-ref-thumb${checked ? ' is-selected' : ''}`}
                        onClick={() => toggle(id)}
                        title={label}
                      >
                        <img src={thumbUrl(id)} alt={label} loading="lazy" />
                        <span className="artwork-ref-check">{checked ? '✓' : ''}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
