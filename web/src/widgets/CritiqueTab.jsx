import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPostJson, apiDelete, apiSseUrl } from '../api.js';
import { scoreBand, formatScore, sortIssues, issueCounts, hasCriteria, SEVERITY_LABELS } from './critiqueDisplay.js';
import { CritiqueSection } from './CritiqueSection.jsx';
import { ClimbDialog, ClimbPanel, ClimbChip, isClimbRunning } from './Climb.jsx';
import { RegenerateDialog } from './RegenerateDialog.jsx';

const CLIMB_POLL_MS = 2000;

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function countsText(counts) {
  const parts = [];
  if (counts.must_fix) parts.push(`${counts.must_fix} must-fix`);
  if (counts.should_fix) parts.push(`${counts.should_fix} should-fix`);
  if (counts.nit) parts.push(`${counts.nit} nit${counts.nit === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// The header row every facet shows: label, scope, score, bar, summary.
function FacetHeader({ f }) {
  return (
    <>
      <span className="lens-name">
        {f.label} <span className={`critique-scope scope-${f.scope}`}>{f.scope === 'story' ? 'Story' : 'Focused'}</span>
      </span>
      {f.status === 'pending' && <span className="lens-comment">scoring…</span>}
      {f.status === 'error' && <span className="lens-comment">errored: {f.error_message}</span>}
      {f.status === 'na' && <span className="lens-comment">not applicable to this beat{f.summary ? ` — ${f.summary}` : ''}</span>}
      {f.status === 'done' && (
        <>
          <span className={`lens-score ${scoreBand(f.score)}`}>{formatScore(f.score)}</span>
          <span className="lens-bar"><i className={scoreBand(f.score)} style={{ width: `${(f.score / 10) * 100}%` }} /></span>
          <span className="lens-comment">{f.summary || f.comments}</span>
        </>
      )}
    </>
  );
}

// The criteria, evidence, issues and strengths behind a v2 facet score.
function FacetDetail({ f }) {
  const criteria = f.criteria || [];
  const issues = sortIssues(f.issues);
  const criterionLabel = (key) => criteria.find((c) => c.key === key)?.label || key;
  return (
    <div className="lens-detail">
      <div className="lens-criteria">
        {criteria.map((c) => (
          <div className="lens-criterion" key={c.key}>
            <span className="lens-criterion-name">{c.label || c.key}</span>
            {c.applicable === false ? (
              <span className="lens-criterion-na">n/a</span>
            ) : (
              <>
                <span className={`lens-score ${scoreBand(c.score)}`}>{formatScore(c.score)}</span>
                <span className="lens-bar"><i className={scoreBand(c.score)} style={{ width: `${((c.score || 0) / 10) * 100}%` }} /></span>
              </>
            )}
            <span className="lens-criterion-body">
              {c.rationale ? <span className="lens-rationale">{c.rationale}</span> : null}
              {(c.evidence || []).map((e, i) => (
                <blockquote className="lens-quote" key={i}>
                  {e.quote ? <span className="lens-quote-text">“{e.quote}”</span> : null}
                  {e.note ? <span className="lens-quote-note">{e.note}</span> : null}
                </blockquote>
              ))}
              {c.to_raise ? <span className="lens-raise"><b>To fix:</b> {c.to_raise}</span> : null}
            </span>
          </div>
        ))}
      </div>
      {issues.length > 0 && (
        <ul className="lens-issues">
          {issues.map((i, n) => (
            <li key={n} className={`sev-${i.severity}`}>
              <span className={`issue-chip sev-${i.severity}`}>{SEVERITY_LABELS[i.severity] || i.severity}</span>
              {i.criterion ? <span className="issue-criterion">{criterionLabel(i.criterion)}</span> : null}
              {i.quote ? <span className="issue-quote">“{i.quote}”</span> : null}
              <span className="issue-problem">{i.problem}</span>
              {i.fix ? <span className="issue-fix"><b>Fix:</b> {i.fix}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {(f.strengths || []).length > 0 && (
        <div className="lens-strengths"><b>Strengths:</b> {f.strengths.join(' · ')}</div>
      )}
    </div>
  );
}

export function CritiqueTab({ beatId, hasPreviousBody, onRefresh }) {
  const [critique, setCritique] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(null); // 'regen' | 'undo' | null
  const [error, setError] = useState(null);
  const [climb, setClimb] = useState(null);
  const [climbOpen, setClimbOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const esRef = useRef(null);
  const climbing = isClimbRunning(climb);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/beat/${beatId}/critique`);
        if (!cancelled) { setCritique(r.critique || null); setClimb(r.climb || null); }
      } catch (e) { if (!cancelled) setError(e.message); }
    })();
    return () => { cancelled = true; if (esRef.current) { esRef.current.close(); esRef.current = null; } setRunning(false); };
  }, [beatId]);

  // A climb runs on the server and writes the critique and its own state to
  // the beat as it goes; follow both by polling until it stops, then reload
  // the beat (new body, Undo slot). Also what reattaches a reopened tab.
  useEffect(() => {
    if (!climbing) return undefined;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const r = await apiGet(`/beat/${beatId}/critique`);
        if (!alive) return;
        setCritique(r.critique || null);
        setClimb(r.climb || null);
        if (!isClimbRunning(r.climb)) await onRefresh?.();
      } catch (e) { if (alive) setError(e.message); }
    }, CLIMB_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [beatId, climbing]);

  async function startClimb(params) {
    setError(null);
    const r = await apiPostJson(`/beat/${beatId}/critique/climb`, params);
    setClimb(r.climb);
  }

  async function cancelClimb() {
    try {
      const r = await apiPostJson(`/beat/${beatId}/critique/climb/cancel`, {});
      setClimb(r.climb);
    } catch (e) { setError(e.message); }
  }

  function closeStream() { if (esRef.current) { esRef.current.close(); esRef.current = null; } }

  async function runCritique() {
    setRunning(true); setError(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/critique`, {});
      const jobId = r?.job_id;
      if (!jobId) throw new Error('server did not return a job id');
      // The run replaces the critique and ends the climb it came from: the
      // old ratings and the climb status go now, and each facet's score is
      // shown as it arrives.
      setClimb(null);
      setCritique((c) => (c ? {
        ...c,
        overall: null,
        strategy: null,
        facets: (c.facets || []).map((f) => ({ key: f.key, label: f.label, scope: f.scope, status: 'pending' })),
      } : c));
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

  // params: {apply?, direction} from the Regenerate dialog.
  async function regenerate(params = {}) {
    setBusy('regen'); setError(null);
    try {
      const r = await apiPostJson(`/beat/${beatId}/regenerate`, params);
      if (r?.strategy) setCritique((c) => (c ? { ...c, strategy: r.strategy } : c));
      setClimb(null);
      await onRefresh?.();
    }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function undo() {
    setBusy('undo'); setError(null);
    try { await apiPostJson(`/beat/${beatId}/restore-body`, {}); await onRefresh?.(); }
    catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  async function clearCritique() {
    if (!confirm('Clear the writing critique? Its scores, issues and the climb status are removed. The beat text is not changed.')) return;
    setBusy('clear'); setError(null);
    try {
      await apiDelete(`/beat/${beatId}/critique`);
      setCritique(null);
      setClimb(null);
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }

  const facets = critique?.facets || [];
  const hasCritique = facets.some((f) => f.status === 'done');
  const counts = issueCounts(facets);
  const countsLabel = countsText(counts);

  const writingMeta = (
    <>
      {critique?.overall != null ? (
        <span className={`critique-overall ${scoreBand(critique.overall)}`}>{formatScore(critique.overall)}<span className="max">/10</span></span>
      ) : <span className="critique-overall none">not critiqued</span>}
      {countsLabel ? <span className="critique-counts">{countsLabel}</span> : null}
      <ClimbChip climb={climb} />
    </>
  );

  return (
    <div className="critique-panel">
      <p className="tab-intro">
        Scores the beat's text against anchored criteria — quoting the lines it judges and ranking every issue by severity — using the
        previous and next beats, the whole-story spine, the director's notes and the dialogue style; you can then rewrite the beat from it.
        The artwork is checked on the <b>Coverage</b> tab.
      </p>

      <CritiqueSection title="Writing" meta={writingMeta}>
        <div className="tab-actions critique-head">
          <span className="spacer" />
          <button type="button" className="primary" disabled={running || climbing} onClick={runCritique}>
            {running ? 'Critiquing…' : critique ? 'Re-run critique' : 'Run critique'}
          </button>
          <button type="button" disabled={!!busy || running || climbing || !hasCritique} onClick={() => setRegenOpen(true)}>
            {busy === 'regen' ? 'Regenerating…' : 'Regenerate beat from critique'}
          </button>
          <button
            type="button"
            disabled={!!busy || running || climbing}
            title="Critique, rewrite from the critique and critique again, until the score reaches a target"
            onClick={() => setClimbOpen(true)}
          >
            {climbing ? 'Climbing…' : 'Climb'}
          </button>
          {hasPreviousBody && (
            <button type="button" disabled={!!busy || climbing} onClick={undo}>{busy === 'undo' ? 'Undoing…' : 'Undo rewrite'}</button>
          )}
          {(critique || climb) && (
            <button type="button" disabled={!!busy || running || climbing} title="Remove the critique and the climb status, to start fresh" onClick={clearCritique}>
              {busy === 'clear' ? 'Clearing…' : 'Clear critique'}
            </button>
          )}
        </div>
        {error && <div className="critique-error">{error}</div>}
        <ClimbPanel climb={climb} onCancel={cancelClimb} />
        {facets.map((f) => (
          f.status === 'done' && hasCriteria(f) ? (
            <details className="critique-lens-detail" key={f.key}>
              <summary className="critique-lens"><FacetHeader f={f} /></summary>
              <FacetDetail f={f} />
            </details>
          ) : (
            <div className="critique-lens" key={f.key}><FacetHeader f={f} /></div>
          )
        ))}
        {critique?.strategy && (
          <details className="critique-strategy" open>
            <summary>Rewrite strategy</summary>
            <div className="critique-strategy-body">{critique.strategy}</div>
          </details>
        )}
      </CritiqueSection>

      <ClimbDialog
        open={climbOpen}
        kind="writing"
        last={climb}
        intro="Critiques the beat, rewrites it from the critique and critiques it again, over and over, until the overall score reaches the target. A rewrite is kept only when it scores higher than the best so far; otherwise the best version is put back and a different strategy is tried. Undo rewrite returns to the text as it is now."
        onStart={startClimb}
        onClose={() => setClimbOpen(false)}
      />

      <RegenerateDialog open={regenOpen} facets={facets} onStart={regenerate} onClose={() => setRegenOpen(false)} />
    </div>
  );
}
