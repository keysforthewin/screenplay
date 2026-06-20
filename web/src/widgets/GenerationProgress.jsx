import { useEffect } from 'react';

// Shared background-job progress panel. Renders the `{status, planned,
// completed, failed, progress, events}` job shape used by storyboard generation
// AND image-sheet generation: a phase pill + a single status line, an
// N/M-rendered · K-failed meta row with elapsed timers, and a toggleable,
// auto-scrolling activity log. The backend normally supplies `progress.message`;
// the `noun` prop only tweaks the fallback copy ("frames" vs "shots").
export function GenerationProgress({ job, showLog, onToggleLog, logRef, noun = 'frame' }) {
  const events = Array.isArray(job?.events) ? job.events : [];
  const progress = job?.progress || null;
  const phase = progress?.phase || job?.status || 'queued';
  const message =
    progress?.message ||
    (phase === 'planning'
      ? `Planning ${noun}s…`
      : phase === 'rendering'
        ? `Rendering ${job?.completed || 0}/${job?.planned || 0} ${noun}s…`
        : phase === 'queued'
          ? 'Queued…'
          : 'Working…');
  const startedAt = progress?.started_at ? new Date(progress.started_at) : null;
  const jobStartedAt = job?.started_at ? new Date(job.started_at) : null;
  const stepElapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)) : null;
  const totalElapsed = jobStartedAt ? Math.max(0, Math.floor((Date.now() - jobStartedAt.getTime()) / 1000)) : null;

  // Auto-scroll the log to the bottom as new events stream in so the most
  // recent step stays visible without the user having to scroll manually.
  useEffect(() => {
    if (showLog && logRef?.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events.length, showLog, logRef]);

  return (
    <div className="storyboard-progress">
      <div className="storyboard-progress-head">
        <span className={`storyboard-progress-phase phase-${phase}`}>{phase.toUpperCase()}</span>
        <span className="storyboard-progress-message">{message}</span>
      </div>
      <div className="storyboard-progress-meta">
        {typeof job?.planned === 'number' && job.planned > 0 && (
          <span>
            {job.completed || 0}/{job.planned} rendered
            {job.failed > 0 && (
              <span style={{ color: 'var(--err, #f88)' }}> · {job.failed} failed</span>
            )}
          </span>
        )}
        {stepElapsed != null && <span>step: {formatElapsed(stepElapsed)}</span>}
        {totalElapsed != null && <span>total: {formatElapsed(totalElapsed)}</span>}
        <button
          type="button"
          className="storyboard-progress-toggle"
          onClick={onToggleLog}
        >
          {showLog ? 'Hide activity log' : `Show activity log (${events.length})`}
        </button>
      </div>
      {showLog && events.length > 0 && (
        <div className="storyboard-progress-log" ref={logRef}>
          {events.map((ev, i) => {
            const ts = ev.ts ? new Date(ev.ts) : null;
            const offset = ts && jobStartedAt
              ? Math.max(0, Math.floor((ts.getTime() - jobStartedAt.getTime()) / 1000))
              : null;
            const failed = /failed|crashed/.test(ev.step || '');
            const done = /done|complete/.test(ev.step || '');
            return (
              <div
                key={i}
                className={`storyboard-progress-event ${failed ? 'is-failed' : done ? 'is-done' : ''}`}
              >
                <span className="storyboard-progress-event-time">
                  {offset != null ? `+${formatElapsed(offset)}` : ''}
                </span>
                <span className="storyboard-progress-event-msg">{ev.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}
