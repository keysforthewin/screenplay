// Per-cut progress list for a running/finished Prompts-tab render job.
import { formatUsd } from '../videoCost.js';

const MODE_LABEL = { lipsync: 'lip-sync', clip: 'clip' };

export function CutRenderProgress({ job }) {
  const cuts = Array.isArray(job?.cuts) ? job.cuts : [];
  if (!cuts.length) return null;
  return (
    <div className="beat-render-shots">
      {cuts.map((c) => {
        const cls =
          c.status === 'done' ? 'is-done'
            : c.status === 'failed' || c.status === 'error' ? 'is-failed'
              : c.skipped ? 'is-skipped'
                : c.status === 'pending' ? 'is-pending'
                  : 'is-active';
        return (
          <div key={c.cut_id} className={`beat-render-shot ${cls}`}>
            <span className="beat-render-shot-order">{c.label}</span>
            <span className="beat-render-shot-mode">
              {c.skipped ? `skipped · ${c.skip_reason}` : MODE_LABEL[c.mode] || c.mode}
              {c.auto_start_frame ? ' + start frame' : ''}
              {c.auto_end_frame ? ' + end frame' : ''}
              {c.model_label && !c.skipped ? ` · ${c.model_label}` : ''}
            </span>
            <span className="beat-render-shot-step">
              {c.skipped ? '' : c.error ? c.error : c.step || c.status}
              {c.queue_position != null && !c.error ? ` (queue ${c.queue_position})` : ''}
            </span>
            {c.estimated_cost_usd != null && <span className="beat-render-shot-cost">{formatUsd(c.estimated_cost_usd)}</span>}
          </div>
        );
      })}
    </div>
  );
}

// One-line phase summary for the panel above the list.
export function cutRenderPhaseText(job) {
  if (!job) return '';
  const n = `${job.completed ?? 0}/${job.planned ?? '?'}`;
  switch (job.status) {
    case 'queued': return 'Render queued…';
    case 'rendering': return `Rendering cuts… ${n}${job.failed ? ` (${job.failed} failed)` : ''}`;
    case 'assembling': return `Clips ready (${n}) — joining them into the beat video…`;
    case 'done': return `Beat video ready — ${n} cut${job.planned === 1 ? '' : 's'} rendered.`;
    case 'partial': return `Rendered ${n}${job.failed ? `, ${job.failed} failed` : ''}. Beat video not assembled: ${job.assembly_skipped_reason || 'some cuts have no clip'}.`;
    case 'error': return `Render failed: ${job.error || 'unknown error'}`;
    default: return job.progress?.message || job.status;
  }
}
