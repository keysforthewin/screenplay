import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson } from '../api.js';
import { pickCritiqueScore, scoreBand } from './critiqueDisplay.js';

export function CritiquePanel({ sb, onRefresh }) {
  const [busy, setBusy] = useState(null); // 'prompt' | 'image' | 'regen' | null
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const shown = sb.image_critique || sb.prompt_critique || null;
  const overall = pickCritiqueScore(sb);
  const hasImage = Boolean(sb.frames?.[0]?.image_id);

  function pollCritique(jobId) {
    pollRef.current = setInterval(async () => {
      try {
        const r = await apiGet(`/storyboard/critique/job/${jobId}`);
        const job = r?.job;
        if (job && (job.status === 'done' || job.status === 'error')) {
          clearInterval(pollRef.current); pollRef.current = null;
          if (job.status === 'error') setError(job.error || 'critique failed');
          setBusy(null);
          await onRefresh?.();
        }
      } catch { /* transient; retry next tick */ }
    }, 2000);
  }

  async function critique(target) {
    setBusy(target); setError(null);
    try {
      const r = await apiPostJson(`/storyboard/${sb._id}/critique?target=${target}`, {});
      pollCritique(r.job_id);
    } catch (e) { setError(e.message); setBusy(null); }
  }

  async function regenerate() {
    setBusy('regen'); setError(null);
    try {
      await apiPostJson(`/storyboard/${sb._id}/reexpand`, { use_critique: true });
      setBusy(null);
      await onRefresh?.();
    } catch (e) { setError(e.message); setBusy(null); }
  }

  return (
    <div className="critique-panel">
      <div className="critique-head">
        {overall != null ? (
          <span className={`critique-overall ${scoreBand(overall)}`}>{overall}<span className="max">/10</span></span>
        ) : <span className="critique-overall none">not critiqued</span>}
        <span className="critique-tiers">
          {sb.prompt_critique && <>prompt <b>{sb.prompt_critique.overall}</b></>}
          {sb.image_critique && <> · render <b>{sb.image_critique.overall}</b></>}
        </span>
        <span className="spacer" />
        <button disabled={busy} onClick={() => critique('prompt')}>{busy === 'prompt' ? 'Critiquing…' : 'Critique prompt'}</button>
        <button disabled={busy || !hasImage} title={hasImage ? '' : 'Render a frame first'} onClick={() => critique('image')}>{busy === 'image' ? 'Critiquing…' : 'Critique image'}</button>
        <button className="primary" disabled={busy || !sb.prompt_critique} onClick={regenerate}>{busy === 'regen' ? 'Regenerating…' : 'Regenerate from critique'}</button>
      </div>
      {error && <div className="critique-error">{error}</div>}
      {shown?.lenses?.map((l) => (
        <div className="critique-lens" key={l.lens}>
          <span className="lens-name">{l.lens.replace(/_/g, ' ')}</span>
          <span className={`lens-score ${scoreBand(l.score)}`}>{l.score}</span>
          <span className="lens-bar"><i className={scoreBand(l.score)} style={{ width: `${(l.score / 10) * 100}%` }} /></span>
          <span className="lens-comment">{l.comments}{l.error ? ' (lens errored)' : ''}</span>
        </div>
      ))}
    </div>
  );
}
