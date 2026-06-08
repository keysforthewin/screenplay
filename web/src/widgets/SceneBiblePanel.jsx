import { useRef, useState, useEffect } from 'react';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { apiGet, apiPostJson } from '../api.js';

const BIBLE_FIELDS = [
  ['location', 'Location'],
  ['time_of_day', 'Time of day'],
  ['lighting_key', 'Lighting key'],
  ['palette', 'Palette'],
  ['mood', 'Mood'],
  ['blocking', 'Blocking'],
  ['continuity_anchors', 'Continuity anchors'],
  ['camera_language', 'Camera language'],
];

export function SceneBiblePanel({ beatId, session, shotCount, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function reexpandAll() {
    if (!window.confirm(`Re-expand prompts for all ${shotCount} shot(s) from the scene bible? This rewrites their prompts.`)) return;
    setBusy(true); setError(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/reexpand-shots`, {});
      pollRef.current = setInterval(async () => {
        try {
          const res = await apiGet(`/beat/reexpand/job/${r.job_id}`);
          const job = res?.job;
          if (job && ['done', 'partial', 'error'].includes(job.status)) {
            clearInterval(pollRef.current); pollRef.current = null;
            if (job.status === 'error') setError(job.error || 're-expand failed');
            setBusy(false);
            await onRefresh?.();
          }
        } catch { /* retry next tick */ }
      }, 2000);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="scene-bible">
      <div className="scene-bible-head" onClick={() => setOpen((o) => !o)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="title">Scene Bible</span>
        <span className="sub">{shotCount} shot{shotCount === 1 ? '' : 's'} inherit this</span>
        <span className="spacer" />
        <button className="primary" disabled={busy} onClick={(e) => { e.stopPropagation(); reexpandAll(); }}>
          {busy ? 'Re-expanding…' : 'Re-expand all shots'}
        </button>
      </div>
      {error && <div className="critique-error">{error}</div>}
      {open && (
        <CollabSurface room={`beat:${beatId}`} session={session}>
          <div className="scene-bible-grid">
            {BIBLE_FIELDS.map(([key, label]) => (
              <div className="scene-bible-field" key={key}>
                <CollabField label={label} field={`scene_bible.${key}`} multiline />
              </div>
            ))}
          </div>
        </CollabSurface>
      )}
    </div>
  );
}
