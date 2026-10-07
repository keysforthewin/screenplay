import { useState } from 'react';
import { apiDelete, apiPatchJson, apiPostJson } from '../api.js';
import { CutFramePanel } from './CutFramePanel.jsx';

function readError(e) {
  let msg = e?.message || 'Request failed.';
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) msg = parsed.error;
  } catch {}
  return msg;
}

const MARGIN = 0.5;
const snapHalf = (n) => Math.round(Number(n) * 2) / 2;

// The midpoint of the widest gap between the frames already placed — where a
// new keyframe lands by default.
export function suggestKeyframeTime(duration, times) {
  const marks = [0, ...times.slice().sort((a, b) => a - b), duration];
  let best = [0, duration];
  for (let i = 1; i < marks.length; i += 1) {
    if (marks[i] - marks[i - 1] > best[1] - best[0]) best = [marks[i - 1], marks[i]];
  }
  const mid = snapHalf((best[0] + best[1]) / 2);
  return Math.min(Math.max(mid, MARGIN), duration - MARGIN);
}

// The keyframes of a cut: pictures the clip must pass through between its
// start and end frame, each at a time inside the cut. A keyframe video model
// renders them all in one generation (spacing = speed); other models ignore
// them. Each keyframe is a CutFramePanel with time / strength controls.
export function CutKeyframes({ cut, beatId, disabled, onRefresh }) {
  const id = String(cut._id);
  const duration = cut.duration_seconds;
  const keyframes = (cut.keyframes || []).slice().sort((a, b) => a.at_seconds - b.at_seconds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function call(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onRefresh?.();
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }

  const canAdd = duration >= 2 * MARGIN + 0.5;
  const addHint = !duration
    ? 'Set the cut\'s duration first'
    : !canAdd
      ? 'The cut is too short for a keyframe'
      : 'Add a picture the clip must pass through at a time inside the cut';

  return (
    <div className="cut-keyframes">
      <div className="cut-keyframes-head">
        <span className="field-label" style={{ margin: 0 }}>Keyframes</span>
        <span className="cut-keyframes-hint">
          {keyframes.length
            ? 'Rendered with the start and end frame in one pass by a keyframe video model — spacing is speed.'
            : 'None. A keyframe pins what the clip shows at a moment between the two frames.'}
        </span>
        <button
          type="button"
          disabled={busy || disabled || !canAdd}
          title={addHint}
          onClick={() => call(() => apiPostJson(`/cut/${id}/keyframe`, { at_seconds: suggestKeyframeTime(duration, keyframes.map((k) => k.at_seconds)) }))}
        >
          + Add keyframe
        </button>
      </div>
      {error ? <div className="error-banner small">{error}</div> : null}
      {duration > 0 && (keyframes.length || cut.start_frame?.image_id || cut.end_frame?.image_id) ? (
        <TimeStrip duration={duration} cut={cut} keyframes={keyframes} />
      ) : null}
      {keyframes.map((k) => (
        <CutFramePanel
          key={String(k.id)}
          cut={cut}
          frame={`kf:${k.id}`}
          beatId={beatId}
          disabled={disabled}
          onRefresh={onRefresh}
          header={<KeyframeHeader cut={cut} keyframe={k} duration={duration} disabled={busy || disabled} call={call} />}
        />
      ))}
    </div>
  );
}

function KeyframeHeader({ cut, keyframe, duration, disabled, call }) {
  const id = String(cut._id);
  const kid = String(keyframe.id);
  const [timeDraft, setTimeDraft] = useState(null);
  const [strengthDraft, setStrengthDraft] = useState(null);
  const max = duration > 0 ? duration - MARGIN : undefined;

  function commitTime() {
    if (timeDraft == null) return;
    const raw = String(timeDraft).trim();
    setTimeDraft(null);
    if (raw === '') return;
    const n = snapHalf(raw);
    if (!Number.isFinite(n) || n < MARGIN || (max != null && n > max)) return;
    if (n !== keyframe.at_seconds) call(() => apiPatchJson(`/cut/${id}/keyframe/${kid}`, { at_seconds: n }));
  }

  function commitStrength() {
    if (strengthDraft == null) return;
    const raw = strengthDraft;
    setStrengthDraft(null);
    const next = raw === '' ? null : Math.round(Number(raw) * 100) / 100;
    if ((next ?? null) !== (keyframe.strength ?? null)) call(() => apiPatchJson(`/cut/${id}/keyframe/${kid}`, { strength: next }));
  }

  const strength = strengthDraft ?? (keyframe.strength ?? '');
  return (
    <>
      <span className="field-label" style={{ margin: 0 }}>Keyframe at</span>
      <input
        type="number"
        min={MARGIN}
        max={max}
        step={0.5}
        value={timeDraft ?? keyframe.at_seconds}
        disabled={disabled}
        onChange={(e) => setTimeDraft(e.target.value)}
        onBlur={commitTime}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        style={{ width: 60 }}
        title="When the clip reaches this picture (0.5 s steps)"
      />
      <span className="cut-keyframe-unit">s</span>
      <label className="cut-keyframe-strength" title="How hard the renderer holds this picture. Blank = the model's default (0.7). Below ~0.6 is a soft guide — position and shape without a pixel lock, for composited frames.">
        <span className="cut-keyframe-unit">strength</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={strength === '' ? 0.7 : strength}
          disabled={disabled}
          onChange={(e) => setStrengthDraft(e.target.value)}
          onMouseUp={commitStrength}
          onTouchEnd={commitStrength}
          onKeyUp={commitStrength}
        />
        <span className="cut-keyframe-unit">{strength === '' ? 'default' : Number(strength).toFixed(2)}</span>
        {strength !== '' ? (
          <button type="button" className="link" disabled={disabled} title="Use the model's default strength" onClick={() => { setStrengthDraft(null); call(() => apiPatchJson(`/cut/${id}/keyframe/${kid}`, { strength: null })); }}>×</button>
        ) : null}
      </label>
      <button
        type="button"
        className="danger"
        disabled={disabled}
        title="Remove this keyframe with its image"
        onClick={() => {
          if (confirm(`Delete the keyframe at ${keyframe.at_seconds} s? Its image, prompt and references go with it.`)) call(() => apiDelete(`/cut/${id}/keyframe/${kid}`));
        }}
      >
        Delete keyframe
      </button>
    </>
  );
}

// 0 … duration with a mark per frame, so the spacing — the speed the model is
// asked for — is visible at a glance.
function TimeStrip({ duration, cut, keyframes }) {
  const pct = (t) => `${Math.min(100, Math.max(0, (t / duration) * 100))}%`;
  const marks = [
    { t: 0, kind: 'start', has: !!cut.start_frame?.image_id, label: 'start' },
    ...keyframes.map((k) => ({ t: k.at_seconds, kind: 'kf', has: !!k.image_id, label: `${k.at_seconds} s` })),
    { t: duration, kind: 'end', has: !!cut.end_frame?.image_id, label: 'end' },
  ];
  return (
    <div className="cut-time-strip" title="Where each frame sits in the cut">
      <div className="cut-time-strip-bar" />
      {marks.map((m, i) => (
        <div key={i} className={`cut-time-mark cut-time-mark-${m.kind}${m.has ? ' has-image' : ''}`} style={{ left: pct(m.t) }} title={`${m.label}${m.has ? '' : ' — no image yet'}`}>
          <span className="cut-time-mark-dot" />
          <span className="cut-time-mark-label">{m.label}</span>
        </div>
      ))}
    </div>
  );
}
