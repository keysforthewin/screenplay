// "Artwork to clear out": what the critique set aside — flawed (a quality
// check looked at it and turned it down), duplicate (the same picture as
// another piece) or not relevant (its description answers nothing this beat
// needs) — each with its picture, its description and why, to tick and
// delete. Nothing is ticked for you. A picture something else depends on (main image,
// wardrobe plate, a cut frame's reference, another beat's coverage) is shown
// but cannot be deleted from here.

import { useEffect, useState } from 'react';
import { apiGet, apiPostJson, thumbUrl, imageUrl } from '../api.js';

export default function IrrelevantArtwork({ beatId, version, disabled, onChanged }) {
  const [items, setItems] = useState([]);
  const [ticked, setTicked] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  async function load() {
    const r = await apiGet(`/beat/${beatId}/artwork-critique/irrelevant`);
    setItems(r.items || []);
    setTicked((t) => new Set([...t].filter((id) => (r.items || []).some((i) => i.artwork_id === id && !i.protected.length))));
  }

  useEffect(() => {
    let alive = true;
    load().catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [beatId, version]);

  const REASON = { flawed: 'Flawed', duplicate: 'Duplicate', irrelevant: 'Not relevant' };
  const count = (r) => items.filter((i) => i.reason === r).length;
  if (!items.length) return null;
  const deletable = items.filter((i) => !i.protected.length);
  const toggle = (id) => setTicked((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function remove() {
    const ids = [...ticked];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} artwork${ids.length === 1 ? '' : 's'} for good? They are removed from their set or character for every beat. This cannot be undone.`)) return;
    setDeleting(true); setError(null); setNote(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/artwork-critique/irrelevant/delete`, { artwork_ids: ids });
      setNote(`${r.deleted.length} deleted${r.skipped.length ? ` · ${r.skipped.length} kept: ${r.skipped.map((s) => s.reason).join('; ')}` : ''}`);
      setTicked(new Set());
      await load();
      onChanged?.();
    } catch (e) { setError(e.message); }
    setDeleting(false);
  }

  return (
    <details className="artwork-critique-irrelevant">
      <summary>
        <b>Artwork to clear out</b>
        <span className="artwork-critique-muted"> {count('flawed')} flawed · {count('duplicate')} duplicate · {count('irrelevant')} not relevant · {deletable.length} can be deleted</span>
      </summary>
      <p className="artwork-critique-muted irrelevant-intro">
        <b>Not relevant</b> and <b>duplicate</b> come from Check coverage, judged from each picture's description, for this beat only.
        {' '}<b>Flawed</b> comes from Check quality, which looks at the pictures: the reviewer said make it again or scored it 5 or lower.
        Sets and characters are shared: a picture here may still be wanted by another beat. Tick what you are sure about; nothing is ticked for you.
      </p>
      <div className="artwork-critique-proposals-head">
        <span className="spacer" />
        <button type="button" className="small" disabled={deleting || disabled} onClick={() => setTicked(new Set(deletable.map((i) => i.artwork_id)))}>Select all</button>
        <button type="button" className="small" disabled={deleting || disabled} onClick={() => setTicked(new Set())}>Select none</button>
        <button type="button" className="danger" disabled={deleting || disabled || ticked.size === 0} onClick={remove}>
          {deleting ? 'Deleting…' : `Delete selected (${ticked.size})`}
        </button>
      </div>
      {error && <div className="critique-error">{error}</div>}
      {note && <div className="artwork-critique-muted">{note}</div>}
      {items.map((i) => {
        const locked = i.protected.length > 0;
        return (
          <label key={i.artwork_id} className={`irrelevant-row${locked ? ' is-protected' : ''}`}>
            <input type="checkbox" checked={ticked.has(i.artwork_id)} disabled={locked || deleting || disabled} onChange={() => toggle(i.artwork_id)} />
            <a href={imageUrl(i.image_id)} target="_blank" rel="noreferrer" title="Open the full picture" onClick={(e) => e.stopPropagation()}>
              <img src={thumbUrl(i.image_id)} alt={i.name || 'artwork'} loading="lazy" />
            </a>
            {i.twin_image_id ? (
              <a href={imageUrl(i.twin_image_id)} target="_blank" rel="noreferrer" title={`The copy that is kept: ${i.twin_name || 'untitled'}`} onClick={(e) => e.stopPropagation()}>
                <img className="irrelevant-twin" src={thumbUrl(i.twin_image_id)} alt="the copy that is kept" loading="lazy" />
              </a>
            ) : <span />}
            <div className="irrelevant-text">
              <div>
                <span className={`critique-scope ${i.host_type === 'set' ? 'scope-story' : ''}`}>{i.host_type === 'set' ? 'Set' : 'Character'}</span>
                {' '}{i.host_name} — <b>{i.name || 'untitled'}</b>
                {i.prop ? <span className="artwork-critique-muted"> · prop plate: {i.prop}</span> : null}
              </div>
              <div className="irrelevant-why"><span className={`irrelevant-reason is-${i.reason}`}>{REASON[i.reason] || i.reason}</span> {i.detail}{i.twin_name ? ` Kept: “${i.twin_name}”.` : ''}</div>
              {locked ? <div className="irrelevant-protected">Kept — in use: {i.protected.join('; ')}</div> : null}
              {!locked && i.also_on_beats.length ? <div className="irrelevant-warn">Its {i.host_type} is also in beat{i.also_on_beats.length === 1 ? '' : 's'} {i.also_on_beats.join(', ')}, which {i.also_on_beats.length === 1 ? 'has' : 'have'} not been checked.</div> : null}
              <div className="irrelevant-desc">{i.description || '(no description)'}</div>
            </div>
          </label>
        );
      })}
    </details>
  );
}
