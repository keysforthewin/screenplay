import { useEffect, useRef, useState } from 'react';

// Live panel for the cut planner (Auto generate / Replan): a step strip (one
// chip per planner pass), a spinner line saying what the model is writing
// RIGHT NOW (items streamed so far, the last one's title, output size, elapsed
// seconds), and a toggleable auto-scrolling activity log. Fed by the SSE
// snapshot shape from src/web/cutPlanner.js#serializeCutPlanJob.

const TERMINAL = new Set(['done', 'partial', 'error']);

const PASS_VERB = {
  scenes: 'scene',
  cuts: 'cut',
  prose: 'block',
  start_frames: 'still prompt',
  review: 'cut reviewed',
};

function secondsSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function fmtSecs(s) {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function stepIcon(status) {
  switch (status) {
    case 'done': return '✓';
    case 'error': return '✗';
    case 'skipped': return '–';
    case 'running': return null; // spinner
    default: return '';
  }
}

// One-line summary of the pass in flight, from the job's `live` block.
export function cutPlanLiveText(job) {
  const live = job?.live;
  if (!live) return null;
  const noun = PASS_VERB[live.pass] || 'item';
  const n = live.items || 0;
  const parts = [];
  parts.push(n ? `${n} ${noun}${n === 1 ? '' : 's'} so far` : 'waiting for the first tokens');
  if (live.item_label) parts.push(`«${live.item_label}»`);
  if (live.chars) parts.push(`${(live.chars / 1000).toFixed(1)}k chars`);
  return parts.join(' · ');
}

export function cutPlanHeadline(job) {
  if (!job) return '';
  const running = (job.steps || []).find((s) => s.status === 'running');
  switch (job.status) {
    case 'queued': return 'Queued…';
    case 'done': return `Done: ${job.scenes_done} scene${job.scenes_done === 1 ? '' : 's'}, ${job.cuts_done} cut${job.cuts_done === 1 ? '' : 's'}${job.lint_count ? `, ${job.lint_count} lint finding${job.lint_count === 1 ? '' : 's'}` : ''}.`;
    case 'partial': return `Finished with failures: ${job.cuts_done} cuts written${job.start_frames ? `, ${job.start_frames.failed} start frame(s) failed` : ''}.`;
    case 'error': return `Error: ${job.error || 'unknown'}`;
    default:
      if (running?.key === 'start_frames' && job.start_frames) {
        const sf = job.start_frames;
        return `Rendering start & end frames (${sf.rendered}/${sf.planned}${sf.failed ? `, ${sf.failed} failed` : ''})…`;
      }
      return running ? `${running.label}…` : 'Working…';
  }
}

export function CutPlanProgress({ job }) {
  const [showLog, setShowLog] = useState(false);
  const [, tick] = useState(0);
  const logRef = useRef(null);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const events = Array.isArray(job?.events) ? job.events : [];
  const warnings = Array.isArray(job?.warnings) ? job.warnings : [];
  const terminal = TERMINAL.has(job?.status);

  // Elapsed timers need a clock even when no snapshot arrives.
  useEffect(() => {
    if (terminal) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [terminal]);

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events.length, showLog]);

  if (!job) return null;
  const running = steps.find((s) => s.status === 'running');
  const liveText = cutPlanLiveText(job);
  const total = secondsSince(job.started_at);
  const stepSecs = secondsSince(running?.started_at);
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const phase = job.status === 'running' ? (running?.key?.split(':')[0] || 'running') : job.status;

  return (
    <div className={`cut-plan-progress storyboard-progress is-${job.status}`}>
      <div className="storyboard-progress-head">
        <span className={`storyboard-progress-phase phase-${job.status}`}>{phase.replace(/_/g, ' ').toUpperCase()}</span>
        <span className="storyboard-progress-message">
          {!terminal ? <span className="spinner cut-plan-spinner" aria-hidden="true" /> : null}
          {cutPlanHeadline(job)}
        </span>
      </div>

      {steps.length ? (
        <div className="cut-plan-steps" role="list">
          {steps.map((s) => {
            const icon = stepIcon(s.status);
            return (
              <span key={s.key} className={`cut-plan-step state-${s.status}`} role="listitem" title={s.detail || s.label}>
                <span className="cut-plan-step-icon">
                  {icon === null ? <span className="spinner cut-plan-spinner-sm" aria-hidden="true" /> : icon}
                </span>
                <span className="cut-plan-step-label">{s.label}</span>
                {s.detail && s.status !== 'running' ? <span className="cut-plan-step-detail">{s.detail.split(':')[0]}</span> : null}
              </span>
            );
          })}
        </div>
      ) : null}

      {!terminal && (liveText || running) ? (
        <div className="cut-plan-live">
          <span className="cut-plan-live-text">{liveText || 'Preparing the request…'}</span>
          {job.live?.tail ? <span className="cut-plan-live-tail">…{job.live.tail}</span> : null}
        </div>
      ) : null}

      <div className="storyboard-progress-meta">
        <span>{doneCount}/{steps.length || '?'} steps</span>
        {stepSecs != null && !terminal ? <span>this step {fmtSecs(stepSecs)}</span> : null}
        {total != null ? <span>total {fmtSecs(total)}</span> : null}
        {job.usage?.output_tokens ? <span>{(job.usage.output_tokens / 1000).toFixed(1)}k tokens out</span> : null}
        {warnings.length ? <span>{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span> : null}
        <button type="button" className="storyboard-progress-toggle" onClick={() => setShowLog((v) => !v)}>
          {showLog ? 'Hide log' : `Show log (${events.length})`}
        </button>
      </div>

      {showLog ? (
        <div className="storyboard-progress-log" ref={logRef}>
          {events.map((e, i) => (
            <div key={i} className={`storyboard-progress-event${/^✓|^◐/.test(e.text) ? ' is-done' : /^✗/.test(e.text) ? ' is-failed' : ''}`}>
              <span className="storyboard-progress-event-time">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className="storyboard-progress-event-msg">{e.text}</span>
            </div>
          ))}
          {!events.length ? <div className="storyboard-progress-event">No activity yet.</div> : null}
        </div>
      ) : null}

      {terminal && warnings.length ? (
        <details style={{ marginTop: 6 }}>
          <summary>{warnings.length} warning{warnings.length === 1 ? '' : 's'}</summary>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{warnings.map((w, i) => <li key={i} className={String(w).startsWith('BLOCKING') ? 'is-blocking' : ''}>{w}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
