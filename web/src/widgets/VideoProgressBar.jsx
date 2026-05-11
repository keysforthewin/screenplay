import { useEffect, useState } from 'react';

// Progress display for fal.ai video generation. fal exposes queue position
// while a request waits in line and a discrete IN_PROGRESS state once
// rendering starts, but no real-time percent. We render two modes:
//   - IN_QUEUE: show the queue position (and indeterminate striped bar)
//   - IN_PROGRESS / preparing / uploading / downloading / persisting: show
//     elapsed time + an indeterminate bar
//   - done: solid 100% green
//   - error: red 0%, message
//
// Re-renders every 500ms while a job is running so the elapsed counter
// advances smoothly between SSE pushes. Reads `started_at` from the job
// itself so the math stays correct after a reconnect.
export function VideoProgressBar({ job }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [job?.status]);

  if (!job) return null;

  const startedAt = job.started_at ? new Date(job.started_at).getTime() : now;
  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));

  let stripeAnim = false;
  let pct;
  let label;
  if (job.status === 'done') {
    pct = 100;
    label = 'Done.';
  } else if (job.status === 'error') {
    pct = 0;
    label = `Error: ${job.error || 'Generation failed.'}`;
  } else if (job.status === 'IN_QUEUE') {
    pct = 12;
    stripeAnim = true;
    label =
      job.queue_position != null && job.queue_position > 0
        ? `Waiting · queue position ${job.queue_position}`
        : `Waiting · elapsed ${formatSec(elapsedSec)}`;
  } else {
    pct = 50;
    stripeAnim = true;
    label = `Elapsed ${formatSec(elapsedSec)}`;
  }

  const stepText = job.step || stepDefault(job.status);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ color: job.status === 'error' ? '#ff8896' : 'var(--fg, inherit)' }}>
          {stepText}
        </span>
        <span style={{ color: 'var(--fg-muted)' }}>{label}</span>
      </div>
      <div
        style={{
          height: 8,
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 4,
          overflow: 'hidden',
        }}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background:
              job.status === 'error'
                ? '#b00020'
                : job.status === 'done'
                  ? '#4caf50'
                  : stripeAnim
                    ? 'repeating-linear-gradient(45deg, var(--accent, #6c8eef) 0 10px, rgba(108,142,239,0.6) 10px 20px)'
                    : 'var(--accent, #6c8eef)',
            transition: 'width 400ms linear',
            animation: stripeAnim ? 'video-progress-stripes 1.4s linear infinite' : undefined,
            backgroundSize: stripeAnim ? '28px 28px' : undefined,
          }}
        />
      </div>
      <style>{`
        @keyframes video-progress-stripes {
          0%   { background-position: 0 0; }
          100% { background-position: 28px 0; }
        }
      `}</style>
    </div>
  );
}

function formatSec(s) {
  const total = Math.max(0, Math.round(s));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const r = total % 60;
  return `${m}m ${r}s`;
}

function stepDefault(status) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'preparing':
      return 'Preparing inputs';
    case 'uploading':
      return 'Uploading inputs to fal';
    case 'submitting':
      return 'Submitting to fal';
    case 'IN_QUEUE':
      return 'Queued at fal';
    case 'IN_PROGRESS':
      return 'Rendering on fal';
    case 'downloading':
      return 'Downloading rendered video';
    case 'persisting':
      return 'Saving video';
    case 'done':
      return 'Done';
    case 'error':
      return 'Error';
    default:
      return status || '';
  }
}
