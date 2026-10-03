// The artwork critique's Climb: critique → generate every proposal the
// critique drafted → critique again, until the beat's artwork coverage
// reaches the target percentage or stops rising (climbCore.js owns the loop
// and the stop rules).
//
// Unlike the writing climb there is nothing to revert: each round ADDS
// artwork to the owning sets / characters, and the score is whatever the next
// audit says about the library as it then stands. A round that does not raise
// the best coverage counts toward the stall limit; its renders stay on file
// (delete them on the set / character page if they are not wanted).
// Dismissed proposals are skipped; proposals are re-drafted by every critique.

import { logger } from '../log.js';
import { analyzeText } from '../llm/analyze.js';
import { modelFor } from '../llm/modelSlots.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { getBeatArtworkCritique } from '../mongo/artworkCritiques.js';
import { isValidImageModel, IMAGE_MODEL_ERROR, assertImageModelConfigured, normalizeImageModel } from './imageModelValidate.js';
import {
  holdArtworkClimb,
  releaseArtworkClimb,
  runArtworkCritiqueForClimb,
  startArtworkGenerateJob,
  waitForArtworkGenerateJob,
} from './artworkCritique.js';
import {
  normalizeClimbParams,
  createClimbState,
  runClimbLoop,
  registerClimb,
  unregisterClimb,
  isClimbRunning,
  saveClimb,
} from './climbCore.js';

const KIND = 'artwork';

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const WALL_SYSTEM = [
  'You explain to a filmmaker why an automatic artwork loop stopped improving the reference artwork for one beat of their screenplay.',
  'The loop audited the artwork on the beat\'s sets and characters against the pictures the writing needs, generated an image for every missing or partly covered requirement, and audited again. It stopped short of the target coverage. You are given the target, the coverage after every round with what was rendered, and the requirements still uncovered with the auditor\'s note on each.',
  'Write for the person who will type a direction for the next run. Plain text, at most 180 words, no markdown headings.',
  'First, two to four sentences on why it stalled. Name the requirements that stayed uncovered and what the auditor kept objecting to: the image model missing the same detail every round, renders that failed, a subject with no portrait or artwork to anchor on, a requirement the prompt cannot express, or places and people the beat names that are not linked to it. Use the notes as evidence; do not guess beyond them.',
  'Then a line reading "Try next:" followed by two to four short lines, each starting with "- ", each a concrete direction the filmmaker could give, a different image model to try, or something to fix by hand (upload a reference, link a set, dismiss a requirement that does not matter).',
].join('\n');

function coverageDetail(critique) {
  const c = critique?.coverage || {};
  return { covered: c.covered ?? 0, partial: c.partial ?? 0, missing: c.missing ?? 0, total: c.total ?? 0 };
}

async function summarizeWall({ projectId, beatId, state }) {
  const critique = await getBeatArtworkCritique(projectId, beatId);
  const reason = state.stop_reason === 'stalled'
    ? `${state.stop_after} rounds in a row did not raise coverage`
    : state.stop_reason === 'nothing_to_improve'
      ? 'requirements are still uncovered but there was no proposal left to generate (the planner drafted none, or they were dismissed)'
      : `the limit of ${state.max_attempts} rounds was reached`;
  const lines = [
    `Target coverage: ${state.target}%. Started at ${state.start_score}%. Best reached: ${state.best_score}%.`,
    `Stopped because: ${reason}.`,
    `Image model: ${state.model}.`,
    state.direction ? `Direction given for this run: ${state.direction}` : 'No direction was given for this run.',
    '',
    '# Rounds',
  ];
  for (const a of state.attempts) {
    const d = a.detail || {};
    lines.push(`Round ${a.n}: coverage ${a.score}% (${d.covered}/${d.total} covered, ${d.partial} partial, ${d.missing} missing) — rendered ${d.rendered ?? 0}${d.failed ? `, ${d.failed} failed` : ''}${a.kept ? ' — new best' : ' — no gain'}`);
    for (const err of d.errors || []) lines.push(`  render failed: ${err}`);
  }
  lines.push('', '# Requirements still uncovered after the last audit');
  for (const s of critique?.subjects || []) {
    const gaps = (s.requirements || []).filter((r) => r.status !== 'covered');
    if (!gaps.length) continue;
    lines.push(`## ${s.kind === 'set' ? 'Set' : 'Character'} "${s.name}" — ${(s.artworks || []).length} artwork(s) audited${s.summary ? ` — ${s.summary}` : ''}`);
    for (const r of gaps) {
      lines.push(`- [${r.category}${r.importance === 'essential' ? ', essential' : ''}, ${r.status}] ${r.summary} — ${r.detail || ''}${r.note ? ` (auditor: ${r.note})` : ''}`);
    }
  }
  if ((critique?.warnings || []).length) lines.push('', '# Warnings', ...critique.warnings.map((w) => `- ${w}`));
  if ((critique?.unlinked_mentions || []).length) {
    lines.push('', '# Named in the beat but not linked to it', ...critique.unlinked_mentions.map((m) => `- ${m.kind} "${m.name}"`));
  }
  return analyzeText({ model: modelFor('storyboard'), system: WALL_SYSTEM, user: lines.join('\n'), maxTokens: 1000 });
}

async function runArtworkClimb({ projectId, beatId, state, discordUser }) {
  let lastRender = { rendered: 0, failed: 0, errors: [] };

  async function evaluate() {
    const job = await runArtworkCritiqueForClimb({ projectId, beatId, direction: state.direction });
    if (job.status === 'error') throw new Error(`The artwork critique failed (${job.error || 'every subject errored'}).`);
    const critique = await getBeatArtworkCritique(projectId, beatId);
    const pct = critique?.coverage?.pct;
    if (typeof pct !== 'number') throw new Error('This beat imposes no artwork requirements, so there is nothing to climb.');
    return { score: pct, detail: { ...coverageDetail(critique), ...lastRender } };
  }

  async function improve() {
    const critique = await getBeatArtworkCritique(projectId, beatId);
    const ids = (critique?.proposals || []).filter((p) => p.status === 'proposed' || p.status === 'error').map((p) => String(p._id));
    if (!ids.length) return false;
    const { job_id: jobId } = await startArtworkGenerateJob({ projectId, beatId, proposalIds: ids, model: state.model, discordUser, climb: true });
    const job = await waitForArtworkGenerateJob(jobId);
    const errors = (job?.items || []).filter((i) => i.status === 'error').map((i) => `${i.name}: ${i.error}`);
    lastRender = { rendered: job?.completed ?? 0, failed: job?.failed ?? 0, errors: errors.slice(0, 5) };
    if (!job || !job.completed) throw new Error(`No artwork could be rendered${errors.length ? ` (${errors[0]})` : job?.error ? ` (${job.error})` : ''}.`);
    return true;
  }

  try {
    await runClimbLoop({
      state,
      evaluate,
      improve,
      summarize: () => summarizeWall({ projectId, beatId, state }),
      save: () => saveClimb(projectId, beatId, state),
    });
    logger.info(`artwork climb: beat=${beatId} stop=${state.stop_reason} start=${state.start_score} best=${state.best_score} rounds=${state.attempts.length}`);
  } finally {
    unregisterClimb(KIND, beatId);
    releaseArtworkClimb(beatId);
  }
  return state;
}

// Start a climb in the background. Returns the initial state (202). Throws
// 400 on bad params / model, 404 on an unknown beat, 409 when a critique, a
// generation or another climb holds the beat.
export async function startArtworkClimb({ projectId, beatId, params, discordUser = null }) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const clean = normalizeClimbParams(params, KIND);
  const model = normalizeImageModel(params?.model);
  if (!(await isValidImageModel(model))) throw httpError(IMAGE_MODEL_ERROR, 400);
  assertImageModelConfigured(model);
  const key = beat._id.toString();
  if (isClimbRunning(KIND, key)) throw httpError('A climb is already running for this beat.', 409);
  if (!holdArtworkClimb(key)) throw httpError('An artwork critique or generation is already running for this beat.', 409);
  const state = createClimbState(KIND, clean, { model });
  registerClimb(KIND, key, state);
  await saveClimb(projectId, key, state);
  setImmediate(() => {
    runArtworkClimb({ projectId, beatId: key, state, discordUser })
      .catch((e) => logger.error(`artwork climb: background run failed: ${e.message}`));
  });
  return state;
}
