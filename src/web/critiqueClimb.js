// The writing critique's Climb: critique → rewrite from the critique →
// critique again, until the overall score reaches the target or stops rising
// (climbCore.js owns the loop and the stop rules).
//
// It is a hill-climb from the best version so far. A rewrite that scores
// higher becomes the new best; one that does not is discarded — the best body
// and its critique are put back — and the next attempt is told which plans
// already failed and what the critics faulted in them. So the beat never ends
// a climb worse than it started, and the critique on the beat always
// describes the body on the beat. Undo rewrite returns to the body the climb
// started from.
//
// An attempt changes the beat in one of two modes (beatRewrite.js): targeted
// edits of the passages at fault once the best score is EDIT_MODE_FLOOR or
// higher — a full rewrite re-rolls every facet, including the ones already
// at 9 — and a full rewrite below it. A discarded attempt switches the next
// one to the other mode.

import { logger } from '../log.js';
import { analyzeText } from '../llm/analyze.js';
import { modelFor } from '../llm/modelSlots.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { setCritiqueStrategy, restoreBeatCritique, stashPreviousBody } from '../mongo/critiques.js';
import { setBeatBodyViaGateway } from './gateway.js';
import { createCritiqueJob, runCritique, holdCritiqueBeat, releaseCritiqueBeat } from './critiqueGenerate.js';
import {
  synthesizeRewriteStrategy,
  regenerateBeatBody,
  planBeatEdits,
  applyBeatEdits,
  describeEditPlan,
  loadRewriteContext,
  summarizeIssuesForHistory,
  formatCritiqueForRewrite,
} from './beatRewrite.js';
import {
  normalizeClimbParams,
  createClimbState,
  runClimbLoop,
  registerClimb,
  unregisterClimb,
  isClimbRunning,
  saveClimb,
} from './climbCore.js';

const KIND = 'writing';
const BODY_SETTLE_MS = 6000;
const BODY_POLL_MS = 200;
export const EDIT_MODE_FLOOR = 7;

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const WALL_SYSTEM = [
  'You explain to a screenwriter why an automatic rewrite loop stopped improving one beat of their screenplay.',
  'The loop critiqued the beat against a fixed rubric, rewrote it from the critique, and critiqued it again, keeping a rewrite only when the overall score rose. It stopped short of the target score. You are given the target, every attempt with its facet scores and the strategy it followed, and the critique of the best version.',
  'Write for the person who will type a direction for the next run. Plain text, at most 180 words, no markdown headings.',
  'First, two to four sentences on why it stalled. Name the facets or criteria that stayed low and say what kept them there: facets that trade off against each other (one rose whenever another fell), an issue every rewrite failed to fix, a direction that pulls against the rubric, or a problem a rewrite of this beat cannot fix because it lives in a neighbouring beat, the story spine, or a missing document such as the director\'s notes or dialogue style. Use the attempt scores as evidence; do not guess beyond them.',
  'Then a line reading "Try next:" followed by two to four short lines, each starting with "- ", each a concrete direction the writer could give or a change they could make by hand.',
].join('\n');

function facetScores(critique) {
  const out = {};
  for (const f of critique?.facets || []) {
    if (f.status === 'done' && f.score != null) out[f.label || f.key] = f.score;
  }
  return out;
}

async function summarizeWall({ state, best, failed }) {
  const lines = [
    `Target overall score: ${state.target}/10. Started at ${state.start_score}/10. Best reached: ${state.best_score}/10.`,
    `Stopped because: ${state.stop_reason === 'stalled' ? `${state.stop_after} attempts in a row did not raise the score` : `the limit of ${state.max_attempts} attempts was reached`}.`,
    state.direction ? `Direction given for this run: ${state.direction}` : 'No direction was given for this run.',
    '',
    '# Attempts',
  ];
  for (const a of state.attempts) {
    const facets = Object.entries(a.detail?.facets || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    const how = a.detail?.mode === 'edit' ? `${a.detail.edits ?? 0} targeted edits` : 'full rewrite';
    lines.push(`Attempt ${a.n} (${how}): overall ${a.score}/10 — ${a.kept ? 'kept (new best)' : 'discarded'}${facets ? ` — ${facets}` : ''}`);
    const lost = failed.find((f) => f.n === a.n);
    if (lost?.strategy) lines.push(`Plan it followed (discarded): ${lost.strategy.slice(0, 1200)}`);
    if (lost?.issues?.length) lines.push('What the critics faulted in it:', ...lost.issues.map((i) => `- ${i}`));
  }
  lines.push('', '# Critique of the best version', formatCritiqueForRewrite(best.critique));
  return analyzeText({ model: modelFor('critique'), system: WALL_SYSTEM, user: lines.join('\n'), maxTokens: 1000 });
}

async function runWritingClimb({ projectId, beatId, state }) {
  const failed = []; // discarded attempts since the last new best: {n, score, mode, facets, strategy, issues}
  let best = null; // {body, critique, score}
  let originalBody = null;
  let pending = null; // the attempt in flight: {mode, strategy, edits}
  let stashed = false;
  let ctx = null; // what the critics score against; the body in it is not used
  const otherMode = (mode) => (mode === 'edit' ? 'rewrite' : 'edit');

  // The gateway writes the y-doc; Mongo follows on the store hook. Wait until
  // the row shows a body other than the one it replaced, so the critique that
  // comes next reads the new text.
  async function writeBody(body) {
    const before = String((await getBeat(projectId, beatId))?.body || '');
    await setBeatBodyViaGateway(projectId, beatId, body);
    if (String(body).trim() === before.trim()) return;
    const deadline = Date.now() + BODY_SETTLE_MS;
    while (Date.now() < deadline) {
      const now = String((await getBeat(projectId, beatId))?.body || '');
      if (now !== before) return;
      await new Promise((r) => setTimeout(r, BODY_POLL_MS));
    }
    logger.warn(`critique climb: beat=${beatId} body did not reach Mongo within ${BODY_SETTLE_MS}ms`);
  }

  async function evaluate() {
    let job = null;
    // A run with an errored facet has a skewed overall; ask once more.
    for (let tries = 0; tries < 2; tries++) {
      job = await runCritique({ projectId, job: createCritiqueJob(beatId) });
      if (job.status === 'done' && job.overall != null) break;
    }
    if (job.status !== 'done' || job.overall == null) {
      const bad = job.facets.filter((f) => f.status === 'error').map((f) => `${f.label}: ${f.error_message}`);
      throw new Error(`The critique did not finish cleanly (${job.error || bad.join('; ') || job.status}).`);
    }
    const beat = await getBeat(projectId, beatId);
    return {
      score: job.overall,
      detail: { facets: facetScores(beat.critique), ...(pending ? { mode: pending.mode, ...(pending.mode === 'edit' ? { edits: pending.edits } : {}) } : {}) },
      body: String(beat.body || ''),
      critique: beat.critique,
    };
  }

  async function improve() {
    const beat = await getBeat(projectId, beatId);
    if (!ctx) ctx = await loadRewriteContext(projectId, beat);
    const args = { beat, critique: best.critique, ctx, direction: state.direction, history: failed };
    const lastFailed = failed.at(-1);
    let mode = lastFailed ? otherMode(lastFailed.mode) : best.score >= EDIT_MODE_FLOOR ? 'edit' : 'rewrite';
    let body = null;
    pending = null;
    if (mode === 'edit') {
      const plan = await planBeatEdits(args);
      const result = applyBeatEdits(beat.body, plan.edits);
      if (result.applied.length) {
        body = result.body;
        pending = { mode, strategy: describeEditPlan({ plan: plan.plan, ...result }), edits: result.applied.length };
      } else {
        // None of the edits could be placed in the body; rewrite instead.
        logger.warn(`critique climb: beat=${beatId} no edit of ${plan.edits.length} could be placed; falling back to a full rewrite`);
        mode = 'rewrite';
      }
    }
    if (mode === 'rewrite') {
      const strategy = await synthesizeRewriteStrategy(args);
      body = await regenerateBeatBody({ ...args, strategy });
      pending = { mode, strategy };
    }
    if (!body || !body.trim()) throw new Error('The rewrite came back empty.');
    await writeBody(body);
  }

  async function keep(result, n) {
    let critique = result.critique;
    if (n > 0) {
      // The first rewrite that is kept fills the Undo slot with the body the
      // climb started from; later bests leave it there.
      if (!stashed) {
        await stashPreviousBody(projectId, beatId, originalBody);
        stashed = true;
      }
      await setCritiqueStrategy(projectId, beatId, pending?.strategy);
      critique = (await getBeat(projectId, beatId))?.critique || critique;
      failed.length = 0;
    } else {
      originalBody = result.body;
    }
    best = { body: result.body, critique, score: result.score };
  }

  async function revert(result, n) {
    if (result) {
      failed.push({
        n,
        score: result.score,
        mode: pending?.mode,
        facets: result.detail?.facets || {},
        strategy: pending?.strategy,
        issues: summarizeIssuesForHistory(result.critique),
      });
    }
    if (!best) return;
    await writeBody(best.body);
    await restoreBeatCritique(projectId, beatId, best.critique);
  }

  try {
    await runClimbLoop({
      state,
      evaluate,
      improve,
      keep,
      revert,
      summarize: () => summarizeWall({ state, best, failed }),
      save: () => saveClimb(projectId, beatId, state),
    });
    logger.info(`critique climb: beat=${beatId} stop=${state.stop_reason} start=${state.start_score} best=${state.best_score} attempts=${state.attempts.length}`);
  } finally {
    unregisterClimb(KIND, beatId);
    releaseCritiqueBeat(beatId);
  }
  return state;
}

// Start a climb in the background. Returns the initial state (202). Throws
// 400 on bad params, 404 on an unknown beat, 409 when a critique or another
// climb holds the beat.
export async function startWritingClimb({ projectId, beatId, params }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const clean = normalizeClimbParams(params, KIND);
  if (!String(beat.body || '').trim()) throw httpError('This beat has no text to climb on.', 400);
  const key = beat._id.toString();
  if (isClimbRunning(KIND, key)) throw httpError('A climb is already running for this beat.', 409);
  if (!holdCritiqueBeat(key)) throw httpError('A critique is already running for this beat.', 409);
  const state = createClimbState(KIND, clean);
  registerClimb(KIND, key, state);
  await saveClimb(projectId, key, state);
  setImmediate(() => {
    runWritingClimb({ projectId, beatId: key, state })
      .catch((e) => logger.error(`critique climb: background run failed: ${e.message}`));
  });
  return state;
}
