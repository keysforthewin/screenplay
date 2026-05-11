import { useEffect, useState } from 'react';

// Time-based progress bar for Wan 2.7 video generation. The API has no
// native progress signal, so we drive the bar from elapsed time vs a
// rolling-average estimate. Bar caps at 95% while the job is running and
// jumps to 100% on `done` so the user gets honest "still working" feedback
// without it ever appearing to stall.
//
// Re-renders on a 500ms tick so the bar advances smoothly between the SPA's
// 2s polls. Reads `started_at` from the job (set server-side at submit)
// rather than the SPA's open time so the math stays correct even when the
// dialog is reopened on a job already in flight.
export function VideoProgressBar({ job, estimatedSeconds }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [job?.status]);

  if (!job) return null;

  const startedAt = job.started_at ? new Date(job.started_at).getTime() : now;
  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const est = Math.max(30, Number(estimatedSeconds) || 180);

  let pct;
  let label;
  if (job.status === 'done') {
    pct = 100;
    label = 'Done.';
  } else if (job.status === 'error') {
    pct = 0;
    label = `Error: ${job.error || 'Generation failed.'}`;
  } else {
    pct = Math.min(95, (elapsedSec / est) * 100);
    const remaining = Math.max(0, est - elapsedSec);
    label = `~${formatSec(remaining)} remaining · elapsed ${formatSec(elapsedSec)}`;
  }

  const stepText = job.step || stepDefault(job.status);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
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
                  : 'var(--accent, #6c8eef)',
            transition: 'width 400ms linear',
          }}
        />
      </div>
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
    case 'loading':
      return 'Loading inputs';
    case 'uploading':
      return 'Uploading inputs to OSS';
    case 'submitting':
      return 'Submitting to Wan 2.7';
    case 'rendering':
      return 'Wan is rendering the video';
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
