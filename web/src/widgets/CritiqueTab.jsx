import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson, apiSseUrl } from '../api.js';
import { scoreBand } from './critiqueDisplay.js';

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export function CritiqueTab({ beatId, hasPreviousBody, onRefresh }) {
  const [critique, setCritique] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(null); // 'regen' | 'undo' | null
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/beat/${beatId}/critique`);
        if (!cancelled) setCritique(r.critique || null);
      } catch (e) { if (!cancelled) setError(e.message); }
    })();
    return () => { cancelled = true; if (esRef.current) esRef.current.close(); };
  }, [beatId]);

  function closeStream() { if (esRef.current) { esRef.current.close(); esRef.current = null; } }

  async function runCritique() {
    setRunning(true); setError(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/critique`, {});
      const jobId = r?.job_id;
      if (!jobId) throw new Error('server did not return a job id');
      const es = new EventSource(apiSseUrl(`/beat/${beatId}/critique/${jobId}/events`));
      esRef.current = es;
      const apply = (ev) => { const snap = safeParse(ev.data); if (snap) setCritique(snap); };
      es.addEventListener('snapshot', apply);
      es.addEventListener('update', apply);
      es.addEventListener('done', (ev) => { apply(ev); setRunning(false); closeStream(); });
      es.addEventListener('error', (ev) => {
        const data = ev?.data ? safeParse(ev.data) : null;
        if (data) { setCritique(data); setError('Critique finished with errors.'); setRunning(false); closeStream(); }
        else if (es.readyState === EventSource.CLOSED) { setRunning(false); setError('Connection lost.'); }
      });
    } catch (e) { setRunning(false); setError(e.message); }
  }

  async function regenerate() {
    setBusy('regen'); setError(null);
    try { await apiPostJson(`/beat/${beatId}/regenerate`, {}); await onRefresh?.(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function undo() {
    setBusy('undo'); setError(null);
    try { await apiPostJson(`/beat/${beatId}/restore-body`, {}); await onRefresh?.(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  const facets = critique?.facets || [];
  const hasCritique = facets.some((f) => f.status === 'done');

  return (
    <div className="critique-panel">
      <p className="tab-intro">
        Run a multi-facet AI critique of this beat — using the previous and next beats and the whole-story spine
        as context — then optionally rewrite the beat from the critique. Rewrites also normalize to screenplay format.
      </p>
      <div className="tab-actions critique-head">
        {critique?.overall != null ? (
          <span className={`critique-overall ${scoreBand(critique.overall)}`}>{critique.overall}<span className="max">/10</span></span>
        ) : <span className="critique-overall none">not critiqued</span>}
        <span className="spacer" />
        <button type="button" className="primary" disabled={running} onClick={runCritique}>
          {running ? 'Critiquing…' : critique ? 'Re-run critique' : 'Run critique'}
        </button>
        <button type="button" disabled={busy || running || !hasCritique} onClick={regenerate}>
          {busy === 'regen' ? 'Regenerating…' : 'Regenerate beat from critique'}
        </button>
        {hasPreviousBody && (
          <button type="button" disabled={busy} onClick={undo}>{busy === 'undo' ? 'Undoing…' : 'Undo rewrite'}</button>
        )}
      </div>
      {error && <div className="critique-error">{error}</div>}
      {facets.map((f) => (
        <div className="critique-lens" key={f.key}>
          <span className="lens-name">
            {f.label} <span className={`critique-scope scope-${f.scope}`}>{f.scope === 'story' ? 'Story' : 'Focused'}</span>
          </span>
          {f.status === 'pending' && <span className="lens-comment">scoring…</span>}
          {f.status === 'error' && <span className="lens-comment">errored: {f.error_message}</span>}
          {f.status === 'done' && (
            <>
              <span className={`lens-score ${scoreBand(f.score)}`}>{f.score}</span>
              <span className="lens-bar"><i className={scoreBand(f.score)} style={{ width: `${(f.score / 10) * 100}%` }} /></span>
              <span className="lens-comment">{f.comments}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
