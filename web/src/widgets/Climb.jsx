// The Climb controls shared by the Writing and Artwork sections of the
// Critique tab: the dialog that starts a climb (score target, optional
// direction, stop after N attempts without a gain) and the panel that shows a
// running climb's progress or the last one's outcome — including, when it
// stopped short of the target, why it hit the wall.
import { useEffect, useState } from 'react';
import { Modal } from './Modal.jsx';

export const CLIMB_KINDS = {
  writing: { min: 1, max: 10, step: 0.1, unit: '/10', defaultTarget: 8.5, noun: 'attempt' },
  artwork: { min: 1, max: 100, step: 1, unit: '%', defaultTarget: 90, noun: 'round' },
};
const DEFAULT_STOP_AFTER = 3;

export function climbScore(kind, score) {
  if (score == null) return '—';
  return kind === 'artwork' ? `${score}%` : Number(score).toFixed(1);
}

export function isClimbRunning(climb) {
  return climb?.status === 'running';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// `last` is the previous climb on this beat (if any): its target, direction
// and stop-after prefill the form, so the next climb starts from the last
// one's settings and the human only edits the direction.
export function ClimbDialog({ open, kind, last, intro, children, canStart = true, onStart, onClose }) {
  const scale = CLIMB_KINDS[kind];
  const [target, setTarget] = useState(String(scale.defaultTarget));
  const [direction, setDirection] = useState('');
  const [stopAfter, setStopAfter] = useState(String(DEFAULT_STOP_AFTER));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTarget(String(last?.target ?? scale.defaultTarget));
    setDirection(last?.direction || '');
    setStopAfter(String(last?.stop_after ?? DEFAULT_STOP_AFTER));
    setError(null);
  }, [open]);

  const targetNum = Number(target);
  const stopNum = Number(stopAfter);
  const valid = Number.isFinite(targetNum) && targetNum >= scale.min && targetNum <= scale.max
    && Number.isInteger(stopNum) && stopNum >= 1 && stopNum <= 10;

  async function start() {
    setBusy(true); setError(null);
    try {
      await onStart({ target: targetNum, direction: direction.trim(), stop_after: stopNum });
      onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal open={open} title={`Climb — ${kind === 'artwork' ? 'artwork' : 'writing'}`} onClose={onClose} dismissible={!busy}>
      <p className="modal-help">{intro}</p>
      <div className="climb-form">
        <label className="climb-field">
          <span className="field-label">Score target ({kind === 'artwork' ? '% covered' : 'overall, out of 10'})</span>
          <input type="number" min={scale.min} max={scale.max} step={scale.step} value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <label className="climb-field">
          <span className="field-label">Stop after</span>
          <span className="climb-inline">
            <input type="number" min={1} max={10} step={1} value={stopAfter} onChange={(e) => setStopAfter(e.target.value)} />
            <span className="modal-help">{scale.noun}s in a row without an increase in score</span>
          </span>
        </label>
        <label className="climb-field is-wide">
          <span className="field-label">Direction (optional)</span>
          <textarea
            rows={4}
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            placeholder={kind === 'artwork'
              ? 'e.g. Every exterior at dusk with wet tarmac. Keep the sedan dark green.'
              : 'e.g. Keep the argument under the surface — nobody says what they mean. Do not add dialogue.'}
          />
        </label>
        {children}
      </div>
      {error && <div className="critique-error">{error}</div>}
      <div className="video-prompt-actions" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={!valid || !canStart || busy} onClick={start}>{busy ? 'Starting…' : 'Start climb'}</button>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function runningLine(climb) {
  const { kind, phase, attempt } = climb;
  const noun = CLIMB_KINDS[kind].noun;
  if (climb.cancel_requested) return 'Stopping after the current step…';
  if (phase === 'baseline') return 'Scoring where it stands now…';
  if (phase === 'improving') return kind === 'artwork' ? `Round ${attempt}: generating the proposed artwork…` : `Attempt ${attempt}: rewriting from the critique…`;
  if (phase === 'scoring') return `${noun[0].toUpperCase()}${noun.slice(1)} ${attempt}: critiquing the result…`;
  if (phase === 'summarizing') return 'Working out why it stalled…';
  return 'Climbing…';
}

function outcomeLine(climb) {
  const { kind } = climb;
  const noun = CLIMB_KINDS[kind].noun;
  const n = (climb.attempts || []).length;
  const best = climbScore(kind, climb.best_score);
  const target = climbScore(kind, climb.target);
  switch (climb.stop_reason) {
    case 'target':
      return n ? `Reached the target of ${target} in ${plural(n, noun)} — now ${best}.` : `Already at ${best}; the target of ${target} was met before any ${noun}.`;
    case 'stalled':
      return `Hit the wall at ${best} (target ${target}): ${plural(climb.stop_after, noun)} in a row did not raise the score.`;
    case 'max_attempts':
      return `Stopped at ${best} (target ${target}) after the limit of ${plural(climb.max_attempts, noun)}.`;
    case 'nothing_to_improve':
      return `Stopped at ${best} (target ${target}): nothing was left to generate.`;
    case 'cancelled':
      return `Cancelled at ${best} (target ${target}) after ${plural(n, noun)}.`;
    default:
      return climb.status === 'interrupted'
        ? `Interrupted at ${best} (target ${target}) — the server restarted mid-climb.`
        : `Failed${climb.best_score != null ? ` at ${best} (target ${target})` : ''}: ${climb.error || 'unknown error'}`;
  }
}

// How a writing attempt changed the beat: targeted edits or a full rewrite.
function attemptMode(a) {
  const d = a.detail || {};
  if (d.mode === 'edit') return ` (${d.edits ?? 0} targeted edit${d.edits === 1 ? '' : 's'})`;
  if (d.mode === 'rewrite') return ' (full rewrite)';
  return '';
}

// start → each attempt's score; kept ones are the steps the climb stands on.
function Trail({ climb }) {
  if (climb.start_score == null) return null;
  return (
    <div className="climb-trail">
      <span className="climb-step is-start" title="Score before the climb">{climbScore(climb.kind, climb.start_score)}</span>
      {(climb.attempts || []).map((a) => (
        <span key={a.n} className={`climb-step ${a.kept ? 'is-kept' : 'is-dropped'}`} title={`${CLIMB_KINDS[climb.kind].noun} ${a.n}${attemptMode(a)}: ${a.kept ? 'new best' : climb.kind === 'artwork' ? 'no gain' : 'no gain — discarded'}`}>
          <span className="climb-arrow">→</span>{climbScore(climb.kind, a.score)}{a.kept ? ' ✓' : ' ✗'}
        </span>
      ))}
      <span className="climb-target">target {climbScore(climb.kind, climb.target)}</span>
    </div>
  );
}

export function ClimbPanel({ climb, onCancel }) {
  if (!climb) return null;
  const running = isClimbRunning(climb);
  const reached = climb.stop_reason === 'target';
  const tone = running ? 'is-running' : reached ? 'is-reached' : climb.status === 'error' || climb.status === 'interrupted' ? 'is-error' : 'is-wall';
  return (
    <div className={`climb-panel ${tone}`}>
      <div className="climb-panel-head">
        <b>Climb</b>
        <span className="climb-panel-line">{running ? runningLine(climb) : outcomeLine(climb)}</span>
        <span className="spacer" />
        {running && onCancel ? <button type="button" className="small" disabled={climb.cancel_requested} onClick={onCancel}>Cancel climb</button> : null}
      </div>
      <Trail climb={climb} />
      {climb.direction ? <div className="climb-direction"><span className="field-label">Direction</span> {climb.direction}</div> : null}
      {!running && climb.wall_summary ? (
        <div className="climb-wall">
          <div className="field-label">Why it hit the wall</div>
          <div className="climb-wall-body">{climb.wall_summary}</div>
          <div className="artwork-critique-muted">Press Climb again with a direction that answers this.</div>
        </div>
      ) : null}
    </div>
  );
}

// The chip on a section's summary row, so a collapsed section still says how
// the last climb ended.
export function ClimbChip({ climb }) {
  if (!climb) return null;
  if (isClimbRunning(climb)) return <span className="climb-chip is-running">climbing…</span>;
  if (climb.stop_reason === 'target') return <span className="climb-chip is-reached">climb reached {climbScore(climb.kind, climb.target)}</span>;
  if (climb.wall_summary || climb.stop_reason === 'stalled') return <span className="climb-chip is-wall">climb hit the wall at {climbScore(climb.kind, climb.best_score)}</span>;
  return null;
}
