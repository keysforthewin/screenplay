import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal.jsx';
import { apiGet, imageUrl, thumbUrl } from '../api.js';

// Multi-select modal that picks reference images for the Artwork dialog.
// Two tabs:
//   "This <host>" — the host's own images[] + its done artworks[] (result_image_id).
//   "Beats"       — every beat's images + done artworks, badged with the beat name.
// Each tab has its own search input that filters by name/desc/filename. The
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

  useEffect(() => {
    if (!open) return;
    setWorking(new Set((selectedIds || []).map(String)));
    setFilter('');
    setTab('this');
    setBeats(null);
    setBeatsError(null);
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

  // Built candidates per tab. We re-derive on every render — these arrays
  // are small (tens to low hundreds at most) so the cost is negligible.
  const thisHostCandidates = useMemo(() => {
    const out = [];
    for (const img of hostImages || []) {
      const c = candidateFromImage(img, `host-${hostType}`, hostLabel || 'this');
      if (c) out.push(c);
    }
    for (const aw of hostArtworks || []) {
      if (aw.status && aw.status !== 'done') continue;
      const c = candidateFromArtwork(aw, `host-${hostType}-artwork`, hostLabel || 'this');
      if (c) out.push(c);
    }
    return out;
  }, [hostImages, hostArtworks, hostType, hostLabel]);

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

  const filterTokens = filter.trim();

  function filterAndExclude(cands) {
    const ex = excludeImageId ? String(excludeImageId) : null;
    return cands.filter((c) => {
      if (ex && c.id === ex) return false;
      return matchesFilter(c, filterTokens);
    });
  }

  const visible = filterAndExclude(tab === 'this' ? thisHostCandidates : beatCandidates);

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

  const tabs = [
    { key: 'this', label: hostLabel ? `This ${hostType} (${hostLabel})` : `This ${hostType}` },
    { key: 'beats', label: 'Beats' },
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

        <input
          type="search"
          className="ref-picker-search"
          placeholder="Filter by name or description…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        {beatsError && <div className="error-banner">{beatsError}</div>}

        <div className="ref-picker-body">
          {tab === 'beats' && beats === null && !beatsError && (
            <p className="ref-picker-empty">Loading beats…</p>
          )}
          {visible.length === 0 ? (
            <p className="ref-picker-empty">
              {filterTokens
                ? 'No matches.'
                : tab === 'this'
                  ? `Nothing attached to this ${hostType} yet.`
                  : 'No images on other beats yet.'}
            </p>
          ) : (
            <div className="artwork-ref-grid">
              {visible.map((cand) => {
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
                    {cand.badge && (
                      <span className="artwork-ref-badge">{cand.badge}</span>
                    )}
                    <span className="artwork-ref-check">{checked ? '✓' : ''}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Re-exports kept so the dialog can render thumbs without re-importing.
export { imageUrl, thumbUrl };
