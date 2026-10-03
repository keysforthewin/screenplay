// The hill-climb shared by the two "Climb" buttons of the Critique tab:
// critique → regenerate from the critique → critique again, until the score
// reaches a target or stops rising. The writing climb (critiqueClimb.js) and
// the artwork climb (artworkClimb.js) supply evaluate / improve / keep /
// revert / summarize; this module owns the loop, the stop rules, the
// in-memory registry of running climbs and the view the routes return.
//
// A climb's state is one object persisted on the beat (src/mongo/climbs.js)
// after every step, so the SPA follows it by polling and a reopened tab
// reattaches for free. Climbs do not survive a restart: a stored `running`
// state with no live entry in the registry is reported as `interrupted`.

import { logger } from '../log.js';
import { getBeatClimb, setBeatClimb } from '../mongo/climbs.js';

export const DEFAULT_STOP_AFTER = 3;
export const MAX_STOP_AFTER = 10;
export const MAX_CLIMB_ATTEMPTS = 12;
export const MAX_DIRECTION_CHARS = 2000;

// The score scale of each kind: writing is the critique's overall (1–10, one
// decimal); artwork is the critique's coverage percentage.
export const CLIMB_SCALES = {
  writing: { min: 1, max: 10, decimals: 1, unit: '/10' },
  artwork: { min: 1, max: 100, decimals: 0, unit: '%' },
};

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function normalizeClimbParams(body, kind) {
  const scale = CLIMB_SCALES[kind];
  if (!scale) throw new Error(`unknown climb kind: ${kind}`);
  const rawTarget = Number(body?.target);
  if (!Number.isFinite(rawTarget) || rawTarget < scale.min || rawTarget > scale.max) {
    throw httpError(`target must be a number from ${scale.min} to ${scale.max}.`, 400);
  }
  const factor = 10 ** scale.decimals;
  const target = Math.round(rawTarget * factor) / factor;
  let stopAfter = DEFAULT_STOP_AFTER;
  if (body?.stop_after != null && body.stop_after !== '') {
    stopAfter = Number(body.stop_after);
    if (!Number.isInteger(stopAfter) || stopAfter < 1 || stopAfter > MAX_STOP_AFTER) {
      throw httpError(`stop_after must be a whole number from 1 to ${MAX_STOP_AFTER}.`, 400);
    }
  }
  const direction = String(body?.direction ?? '').trim();
  if (direction.length > MAX_DIRECTION_CHARS) {
    throw httpError(`direction is limited to ${MAX_DIRECTION_CHARS} characters.`, 400);
  }
  return { target, direction, stop_after: stopAfter };
}

export function createClimbState(kind, params, extra = {}) {
  return {
    kind,
    status: 'running',
    phase: 'baseline', // baseline | improving | scoring | summarizing | done
    target: params.target,
    direction: params.direction,
    stop_after: params.stop_after,
    max_attempts: MAX_CLIMB_ATTEMPTS,
    attempt: 0,
    stalls: 0,
    start_score: null,
    best_score: null,
    last_score: null,
    attempts: [],
    // target | stalled | max_attempts | nothing_to_improve | cancelled | error
    stop_reason: null,
    wall_summary: null,
    error: null,
    cancel_requested: false,
    started_at: new Date(),
    finished_at: null,
    ...extra,
  };
}

// ── Registry of running climbs ──

const running = new Map(); // `${kind}:${beatId}` → state

const keyOf = (kind, beatId) => `${kind}:${String(beatId)}`;

export function isClimbRunning(kind, beatId) {
  return running.has(keyOf(kind, beatId));
}

export function registerClimb(kind, beatId, state) {
  running.set(keyOf(kind, beatId), state);
}

export function unregisterClimb(kind, beatId) {
  running.delete(keyOf(kind, beatId));
}

// Ask a running climb to stop. The step in flight finishes first (a model
// call or a render cannot be recalled). False when nothing is running.
export function requestClimbCancel(kind, beatId) {
  const state = running.get(keyOf(kind, beatId));
  if (!state) return false;
  state.cancel_requested = true;
  return true;
}

// The climb as the routes return it: the live state while it runs, else what
// is stored — with a `running` left behind by a restart shown as interrupted.
export async function getClimbView(projectId, beatId, kind) {
  const live = running.get(keyOf(kind, beatId));
  if (live) return { ...live, attempts: live.attempts.map((a) => ({ ...a })) };
  const stored = await getBeatClimb(projectId, beatId, kind);
  if (stored?.status === 'running') {
    return { ...stored, status: 'interrupted', phase: 'done', error: 'The server restarted while this climb was running.' };
  }
  return stored;
}

export function saveClimb(projectId, beatId, state) {
  return setBeatClimb(projectId, beatId, state.kind, { ...state, attempts: state.attempts.map((a) => ({ ...a })) })
    .catch((e) => logger.warn(`climb: persist failed: ${e.message}`));
}

// Reasons a human can do something about; these get a "why we hit the wall"
// summary. A reached target needs none; a cancel or a crash explains itself.
const WALL_REASONS = new Set(['stalled', 'max_attempts', 'nothing_to_improve']);

// The loop. Callbacks:
//   evaluate(n)  → {score, detail?, …}  run the critique and score it (n = 0 is the baseline,
//                which may return a critique already on file for the current version)
//   improve(n)   → false when there is nothing left to regenerate, anything else otherwise
//   keep(result, n)    the attempt raised the best score (also called for the baseline)
//   revert(result, n)  the attempt did not — put the best version back (also on cancel / error, with null)
//   summarize()  → string  why the climb stopped short of the target
//   save()       persist `state`
// Never throws: a failure ends the climb with status `error`.
export async function runClimbLoop({ state, evaluate, improve, keep, revert, summarize, save }) {
  const persist = async () => { try { await save?.(); } catch (e) { logger.warn(`climb: save failed: ${e.message}`); } };
  try {
    await persist();
    const base = await evaluate(0);
    state.start_score = base.score;
    state.best_score = base.score;
    state.last_score = base.score;
    await keep?.(base, 0);
    while (!state.stop_reason) {
      if (state.best_score >= state.target) { state.stop_reason = 'target'; break; }
      if (state.cancel_requested) { state.stop_reason = 'cancelled'; break; }
      if (state.stalls >= state.stop_after) { state.stop_reason = 'stalled'; break; }
      if (state.attempts.length >= state.max_attempts) { state.stop_reason = 'max_attempts'; break; }
      const n = state.attempts.length + 1;
      state.attempt = n;
      state.phase = 'improving';
      await persist();
      if ((await improve(n)) === false) { state.stop_reason = 'nothing_to_improve'; break; }
      if (state.cancel_requested) {
        await revert?.(null, n);
        state.stop_reason = 'cancelled';
        break;
      }
      state.phase = 'scoring';
      await persist();
      const result = await evaluate(n);
      const kept = result.score > state.best_score;
      state.last_score = result.score;
      state.attempts.push({ n, score: result.score, kept, detail: result.detail || null, at: new Date() });
      if (kept) {
        state.best_score = result.score;
        state.stalls = 0;
        await keep?.(result, n);
      } else {
        state.stalls += 1;
        await revert?.(result, n);
      }
      await persist();
    }
  } catch (e) {
    logger.warn(`climb: ${state.kind} climb failed: ${e.message}`);
    state.stop_reason = 'error';
    state.error = e.message;
    try { await revert?.(null, state.attempt); } catch (err) { logger.warn(`climb: revert after error failed: ${err.message}`); }
  }
  if (WALL_REASONS.has(state.stop_reason) && summarize) {
    state.phase = 'summarizing';
    await persist();
    try {
      state.wall_summary = String((await summarize()) || '').trim() || null;
    } catch (e) {
      logger.warn(`climb: wall summary failed: ${e.message}`);
      state.wall_summary = null;
    }
  }
  state.status = state.stop_reason === 'error' ? 'error' : 'done';
  state.phase = 'done';
  state.finished_at = new Date();
  await persist();
  return state;
}
