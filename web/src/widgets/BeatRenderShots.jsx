// Per-shot progress list for a running/finished beat render job.
import { formatUsd } from '../videoCost.js';

const MODE_LABEL = { lipsync: 'lip-sync', direct: 'direct', start_only: 'from still' };

export function BeatRenderShots({ job }) {
  const shots = Array.isArray(job?.shots) ? job.shots : [];
  if (!shots.length) return null;
  return (
    <div className="beat-render-shots">
      {shots.map((s) => {
        const cls =
          s.status === 'done' ? 'is-done'
            : s.status === 'failed' || s.status === 'error' ? 'is-failed'
              : s.skipped ? 'is-skipped'
                : s.status === 'pending' ? 'is-pending'
                  : 'is-active';
        return (
          <div key={s.storyboard_id} className={`beat-render-shot ${cls}`}>
            <span className="beat-render-shot-order">#{s.order + 1}</span>
            <span className="beat-render-shot-mode">
              {s.skipped ? `skipped · ${s.skip_reason}` : MODE_LABEL[s.mode] || s.mode}
              {s.auto_keyframe ? ' + still' : ''}
            </span>
            <span className="beat-render-shot-step">
              {s.skipped ? '' : s.error ? s.error : s.step || s.status}
              {s.queue_position != null && !s.error ? ` (queue ${s.queue_position})` : ''}
            </span>
            {s.estimated_cost_usd != null && <span className="beat-render-shot-cost">{formatUsd(s.estimated_cost_usd)}</span>}
          </div>
        );
      })}
    </div>
  );
}
