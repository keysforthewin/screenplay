// The artwork critique's Climb: improve the artwork a beat leans on until its
// quality-weighted coverage (`coverage.quality_pct`) reaches the target or
// stops rising (climbCore.js owns the loop and the stop rules).
//
// The library on file is the starting point, not something to replace. Two
// phases, each round working from the stored critique:
//   1. COVERAGE — the critique matches the requirements against the artwork
//      DESCRIPTIONS (text only). While a requirement has no picture, a round
//      renders one (prompt + references) for each and nothing else; only the
//      new renders are looked at.
//   2. QUALITY — once every requirement has a picture, the reviewer scores
//      the matched pieces on the rubric and says keep / edit / regenerate:
//      an `edit` piece is EDITED IN PLACE (same artwork, old image in its
//      undo slot) and re-reviewed, and the edit undone if its score did not
//      rise; a `regenerate` piece — or one whose edits stopped helping — gets
//      a NEW render from a fresh proposal.
// Each critique run is incremental (artworkCritique.js): only the pieces the
// round touched go back to vision. New renders are never deleted — a round
// that does not raise the best score just counts toward the stall limit.
// Dismissed proposals stay dismissed.

import { logger } from '../log.js';
import { analyzeText } from '../llm/analyze.js';
import { modelFor } from '../llm/modelSlots.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { getBeatArtworkCritique } from '../mongo/artworkCritiques.js';
import { composeClimbEditPrompt, requirementNeedsRegeneration, reviewFindings, KEEP_SCORE } from './artworkCritiqueRules.js';
import { editArtworkImageInline, undoArtworkEdit } from './artworkJobs.js';
import { kickoffArtworkVisionSeed } from './artworkVisionWorker.js';
import { runPool } from './imageSheetJobs.js';
import { isValidImageModel, IMAGE_MODEL_ERROR, assertImageModelConfigured, normalizeImageModel } from './imageModelValidate.js';
import {
  holdArtworkClimb,
  releaseArtworkClimb,
  runArtworkCritiqueForClimb,
  applyArtworkEntryChanges,
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
const EDIT_CONCURRENCY = 3;
// A reviewed artwork under this score is worth an edit.
const EDIT_SCORE_FLOOR = KEEP_SCORE;
// Edits in a row that did not raise an artwork's score before it is left alone.
const MAX_EDIT_ATTEMPTS = 2;

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const WALL_SYSTEM = [
  'You explain to a filmmaker why an automatic artwork loop stopped improving the reference artwork for one beat of their screenplay.',
  'The loop first matched the artwork on the beat\'s sets and characters to the pictures the writing needs (by description) and rendered a new image for every requirement nothing answered. Then a reviewer looked at the matched pieces, scored each on a rubric and chose keep / edit / regenerate: edits were applied in place (and undone when the score did not rise), regenerations rendered as new images. Its score is the share of requirements answered, weighted by the rubric score of the best reviewed piece answering each. It stopped short of the target. You are given the target, the score after every round with what was edited and rendered, and the requirements still uncovered or weakly covered with the auditor\'s note on each.',
  'Write for the person who will type a direction for the next run. Plain text, at most 180 words, no markdown headings.',
  'First, two to four sentences on why it stalled. Name the requirements that stayed uncovered and what the auditor kept objecting to: the image model missing the same detail every round, renders that failed, a subject with no portrait or artwork to anchor on, a requirement the prompt cannot express, or places and people the beat names that are not linked to it. Use the notes as evidence; do not guess beyond them.',
  'Then a line reading "Try next:" followed by two to four short lines, each starting with "- ", each a concrete direction the filmmaker could give, a different image model to try, or something to fix by hand (upload a reference, link a set, dismiss a requirement that does not matter).',
].join('\n');

// What the climb is doing right now, for the SPA (it polls the live state):
// `state.activity` — per artwork id, the latest thing the climb did to it
// ({status: queued|editing|checking|kept|undone|failed, name, round, from?,
// to?, image_id?, error?}); `state.rendering` — proposals being rendered as
// new artwork; `state.events` — a capped log of every step.
const MAX_EVENTS = 80;

function note(state, text) {
  state.events = [...(state.events || []), { at: new Date(), text }].slice(-MAX_EVENTS);
}

function mark(state, artworkId, patch) {
  const key = String(artworkId);
  state.activity = { ...(state.activity || {}), [key]: { ...(state.activity?.[key] || {}), ...patch } };
}

const quoted = (names) => names.map((n) => `"${n || 'untitled'}"`).join(', ');

function coverageDetail(critique) {
  const c = critique?.coverage || {};
  return { covered: c.covered ?? 0, partial: c.partial ?? 0, missing: c.missing ?? 0, total: c.total ?? 0 };
}

async function summarizeWall({ projectId, beatId, state }) {
  const critique = await getBeatArtworkCritique(projectId, beatId);
  const reason = state.stop_reason === 'stalled'
    ? `${state.stop_after} rounds in a row did not raise the score`
    : state.stop_reason === 'nothing_to_improve'
      ? 'the score is short of the target but there was nothing left to edit or render (no edit suggested, the edits were undone, the planner drafted nothing, or the proposals were dismissed)'
      : `the limit of ${state.max_attempts} rounds was reached`;
  const lines = [
    `Target score: ${state.target}%. Started at ${state.start_score}%. Best reached: ${state.best_score}%.`,
    `Stopped because: ${reason}.`,
    `Image model: ${state.model}.`,
    state.direction ? `Direction given for this run: ${state.direction}` : 'No direction was given for this run.',
    '',
    '# Rounds',
  ];
  for (const a of state.attempts) {
    const d = a.detail || {};
    lines.push(`Round ${a.n}: score ${a.score}% (${d.covered}/${d.total} covered, ${d.partial} partial, ${d.missing} missing) — ${d.edited ?? 0} edit(s) kept, ${d.reverted ?? 0} undone, ${d.rendered ?? 0} new render(s)${d.failed ? `, ${d.failed} failed` : ''}${a.kept ? ' — new best' : ' — no gain'}`);
    for (const err of d.errors || []) lines.push(`  render failed: ${err}`);
  }
  lines.push('', '# Requirements still uncovered or weakly covered after the last audit');
  for (const s of critique?.subjects || []) {
    const byId = new Map((s.artworks || []).map((e) => [String(e.artwork_id), e]));
    const best = (r) => byId.get(String((r.covered_by || [])[0] || ''));
    const gaps = (s.requirements || []).filter((r) => r.status !== 'covered' || (best(r)?.score ?? 10) < EDIT_SCORE_FLOOR);
    if (!gaps.length) continue;
    lines.push(`## ${s.kind === 'set' ? 'Set' : 'Character'} "${s.name}" — ${(s.artworks || []).length} artwork(s) audited${s.summary ? ` — ${s.summary}` : ''}`);
    for (const r of gaps) {
      const e = best(r);
      const issues = (e?.issues || []).map((i) => i.note).join('; ');
      lines.push(`- [${r.category}${r.importance === 'essential' ? ', essential' : ''}, ${r.status}] ${r.summary} — ${r.detail || ''}${r.note ? ` (auditor: ${r.note})` : ''}${e ? ` (best piece "${e.name}" ${e.score ?? '?'}/10${issues ? `: ${issues}` : ''}${e.edit_attempts ? `; ${e.edit_attempts} edit(s) undone` : ''})` : ''}`);
    }
  }
  if ((critique?.warnings || []).length) lines.push('', '# Warnings', ...critique.warnings.map((w) => `- ${w}`));
  if ((critique?.unlinked_mentions || []).length) {
    lines.push('', '# Named in the beat but not linked to it', ...critique.unlinked_mentions.map((m) => `- ${m.kind} "${m.name}"`));
  }
  return analyzeText({ model: modelFor('storyboard'), system: WALL_SYSTEM, user: lines.join('\n'), maxTokens: 1000 });
}

const missingRequirements = (critique) => (critique?.subjects || []).flatMap((s) => (s.requirements || []).filter((r) => r.status === 'missing'));

// What a quality round does to ONE artwork: the in-place edit the reviewer
// asked for. Only the best REVIEWED piece answering a requirement is touched,
// and only when the reviewer chose `edit` (or it only partly answers the
// requirement) and it scores under EDIT_SCORE_FLOOR. A piece the reviewer
// wants regenerated, or whose last MAX_EDIT_ATTEMPTS edits did not help, is
// left alone — its requirement gets a new render instead (planRenders).
function planEdits(critique, direction) {
  const edits = [];
  for (const subject of critique?.subjects || []) {
    const byId = new Map((subject.artworks || []).map((e) => [String(e.artwork_id), e]));
    const plans = new Map();
    for (const r of subject.requirements || []) {
      if (r.status === 'missing') continue;
      const entry = byId.get(String((r.covered_by || [])[0] || ''));
      if (!entry || !entry.audited_image_id) continue; // not looked at yet
      if (entry.action === 'regenerate' || (entry.edit_attempts || 0) >= MAX_EDIT_ATTEMPTS) continue;
      if (Number.isFinite(entry.score) && entry.score >= EDIT_SCORE_FLOOR && r.status !== 'partial') continue;
      const fit = (entry.fits || []).find((f) => f.requirement_id === r.id);
      const wanted = r.status === 'partial' || (entry.action !== 'keep' && !!entry.suggested_edit);
      if (!wanted) continue;
      const key = String(entry.artwork_id);
      if (!plans.has(key)) plans.set(key, { subject, entry, lacking: [] });
      if (r.status === 'partial') plans.get(key).lacking.push({ summary: r.summary, lacking: fit?.lacking || r.note || r.detail });
    }
    const summaryOf = new Map((subject.requirements || []).map((r) => [r.id, r.summary]));
    for (const plan of plans.values()) {
      const keep = (plan.entry.fits || []).filter((f) => f.fit === 'covered').map((f) => summaryOf.get(f.requirement_id));
      // What is wrong (the explanation) and the edit that applies ALL of it.
      const findings = reviewFindings(plan.entry);
      const prompt = composeClimbEditPrompt({ suggestedEdit: plan.entry.suggested_edit, lacking: plan.lacking, keep, direction, findings });
      if (prompt) edits.push({ ...plan, prompt, findings });
    }
  }
  return { edits };
}

// The proposals a round renders as NEW artwork: those answering a requirement
// nothing on file answers, and — unless `onlyMissing` (the coverage phase) —
// one whose best piece the reviewer wants made again or that edits stopped
// improving.
function planRenders(critique, { onlyMissing = false } = {}) {
  const open = new Set();
  for (const s of critique?.subjects || []) {
    for (const r of s.requirements || []) {
      if (r.status === 'missing' || (!onlyMissing && requirementNeedsRegeneration(r, s.artworks || [], critique?.proposals || [], MAX_EDIT_ATTEMPTS))) open.add(r.id);
    }
  }
  return (critique?.proposals || [])
    .filter((p) => p.status === 'proposed' || p.status === 'error')
    .filter((p) => (p.requirement_ids || []).some((id) => open.has(String(id))))
    .map((p) => String(p._id));
}

function coveredFits(entry) {
  return (entry?.fits || []).filter((f) => f.fit === 'covered').length;
}

// An edit is kept when the artwork scores higher than it did, or answers
// more (or more fully) without scoring lower.
function editImproved(before, after) {
  if (!after || !after.audited_image_id) return false;
  const was = before.score ?? 0;
  const now = after.score ?? 0;
  if (now > was) return true;
  if (now < was) return false;
  return coveredFits(after) > coveredFits(before) || (after.fits || []).length > (before.fits || []).length;
}

async function runArtworkClimb({ projectId, beatId, state, discordUser }) {
  let lastRound = { edited: 0, reverted: 0, rendered: 0, failed: 0, errors: [] };
  let focus = [];

  async function critiqueRun(focusArtworkIds, review = state.coverage_blocked ? 'all' : 'auto') {
    // The critique's own progress, per subject, for the page.
    const onProgress = (snap) => {
      state.audit = {
        phase: snap.phase,
        subjects: (snap.subjects || []).map((s) => ({ id: String(s.id), name: s.name, status: s.status, audited: s.audited || 0, reused: s.reused || 0, artworks_total: s.artworks_total || 0 })),
      };
    };
    let job;
    try {
      job = await runArtworkCritiqueForClimb({ projectId, beatId, direction: state.direction, focusArtworkIds, onProgress, review });
    } finally {
      state.audit = null;
    }
    if (job.status === 'error') throw new Error(`The artwork critique failed (${job.error || 'every subject errored'}).`);
    return getBeatArtworkCritique(projectId, beatId);
  }

  // Incremental: the baseline reuses whatever a previous run audited, a round
  // looks only at the pieces it edited or rendered.
  async function evaluate(n) {
    note(state, n === 0
      ? 'Checking the artwork on file (only pieces that changed since the last critique are looked at)…'
      : focus.length ? `Round ${n}: checking ${focus.length} new render${focus.length === 1 ? '' : 's'}…` : `Round ${n}: scoring…`);
    const critique = await critiqueRun(focus);
    focus = [];
    state.rendering = [];
    const score = critique?.coverage?.quality_pct;
    if (typeof score !== 'number') throw new Error('This beat imposes no artwork requirements, so there is nothing to climb.');
    const d = coverageDetail(critique);
    const c = critique.coverage || {};
    state.stage = d.missing && !state.coverage_blocked ? 'coverage' : 'quality';
    note(state, `${n === 0 ? 'Starting point' : `Round ${n}`}: coverage ${c.pct ?? 0}% (${d.total - d.missing}/${d.total} requirements have a picture), quality ${score}% (${c.reviewed ?? 0} reviewed).`);
    if (n === 0) {
      note(state, d.missing
        ? `Phase 1 — coverage: ${d.missing} requirement${d.missing === 1 ? ' has' : 's have'} no picture on file. Those are rendered first; the library is reviewed once everything is covered.`
        : 'Phase 2 — quality: every requirement has a picture; the reviewer has scored the best match for each.');
    }
    return { score, detail: { ...d, ...lastRound } };
  }

  // Edit in place, re-audit just those pieces, undo the edits that did not
  // help. Returns how many were kept.
  async function runEdits(edits, errors, n) {
    const done = [];
    for (const e of edits) {
      mark(state, e.entry.artwork_id, { status: 'queued', name: e.entry.name || '', round: n, from: e.entry.score ?? null, to: null, image_id: null, error: null, prompt: e.prompt, why: e.findings });
      note(state, `"${e.entry.name || 'untitled'}" (${e.subject.name}, ${e.entry.score ?? '?'}/10) needs: ${e.findings.join('; ') || e.entry.suggested_edit || 'what its requirement lacks'}. Edit sent: ${e.prompt}`);
    }
    note(state, `Round ${n}: editing ${edits.length} piece${edits.length === 1 ? '' : 's'} in place — ${quoted(edits.map((e) => e.entry.name))}.`);
    await runPool(edits, EDIT_CONCURRENCY, async (e) => {
      const hostId = String(e.subject.id);
      const artworkId = String(e.entry.artwork_id);
      mark(state, artworkId, { status: 'editing' });
      try {
        const edited = await editArtworkImageInline({
          projectId,
          hostType: e.subject.kind,
          hostId,
          artworkId,
          prompt: e.prompt,
          model: state.model,
          currentResultImageId: e.entry.audited_image_id,
          discordUser,
          describe: false,
        });
        done.push(e);
        mark(state, artworkId, { status: 'checking', image_id: edited?.fileId ? String(edited.fileId) : null });
        note(state, `Edited "${e.entry.name || 'untitled'}" (${e.subject.name}) — waiting for its re-check.`);
      } catch (err) {
        mark(state, artworkId, { status: 'failed', error: err.message });
        note(state, `Edit of "${e.entry.name || 'untitled'}" failed: ${err.message}`);
        errors.push(`${e.entry.name || 'artwork'}: ${err.message}`);
        logger.warn(`artwork climb: edit ${e.subject.kind}:${hostId} artwork=${artworkId} failed: ${err.message}`);
      }
    });
    if (!done.length) return { kept: 0, reverted: 0, failed: edits.length };
    note(state, `Round ${n}: re-checking the ${done.length} edited piece${done.length === 1 ? '' : 's'}…`);
    const after = await critiqueRun(done.map((e) => String(e.entry.artwork_id)));
    const changes = [];
    let kept = 0;
    for (const e of done) {
      const hostId = String(e.subject.id);
      const artworkId = String(e.entry.artwork_id);
      const subject = (after?.subjects || []).find((s) => String(s.id) === hostId);
      const now = (subject?.artworks || []).find((a) => String(a.artwork_id) === artworkId);
      const was = e.entry.score ?? '?';
      if (editImproved(e.entry, now)) {
        kept += 1;
        mark(state, artworkId, { status: 'kept', to: now.score ?? null });
        note(state, `Kept the edit of "${e.entry.name || 'untitled'}": ${was} → ${now.score ?? '?'}/10.`);
        changes.push({ subjectId: hostId, artworkId, patch: { edit_attempts: 0 } });
        kickoffArtworkVisionSeed({ projectId, hostType: e.subject.kind, hostId, artworkId });
        continue;
      }
      // Put the picture and its audit back as they were; remember the miss.
      mark(state, artworkId, { status: 'undone', to: now?.score ?? null, image_id: null });
      note(state, `Undid the edit of "${e.entry.name || 'untitled'}": ${now ? `${was} → ${now.score ?? '?'}/10, no gain` : 'it could not be re-checked'}.`);
      await undoArtworkEdit({ projectId, hostType: e.subject.kind, hostId, artworkId })
        .catch((err) => logger.warn(`artwork climb: undo ${artworkId} failed: ${err.message}`));
      changes.push({ subjectId: hostId, artworkId, entry: { ...e.entry, edit_attempts: (e.entry.edit_attempts || 0) + 1 } });
    }
    await applyArtworkEntryChanges({ projectId, beatId, changes });
    return { kept, reverted: done.length - kept, failed: edits.length - done.length };
  }

  async function render(ids, critique, n, errors, why) {
    const picked = (critique?.proposals || []).filter((p) => ids.includes(String(p._id)));
    state.rendering = picked.map((p) => ({ proposal_id: String(p._id), name: p.name || '', host_name: p.host_name || '', why: p.review_brief || '' }));
    for (const p of picked) {
      note(state, `New image "${p.name}" (${p.host_name})${p.review_brief ? ` — the reviewer's findings it has to put right: ${p.review_brief}` : ` — ${p.rationale || 'nothing on file answers its requirement'}`}. Prompt: ${p.prompt}`);
    }
    note(state, `Round ${n}: rendering ${ids.length} new image${ids.length === 1 ? '' : 's'} ${why} — ${quoted(picked.map((p) => p.name))}.`);
    const { job_id: jobId } = await startArtworkGenerateJob({ projectId, beatId, proposalIds: ids, model: state.model, discordUser, climb: true });
    const job = await waitForArtworkGenerateJob(jobId);
    errors.push(...(job?.items || []).filter((i) => i.status === 'error').map((i) => `${i.name}: ${i.error}`));
    if (job?.error) errors.push(job.error);
    focus = (job?.items || []).filter((i) => i.artwork_id).map((i) => String(i.artwork_id));
    for (const i of job?.items || []) {
      note(state, i.status === 'error' ? `Render of "${i.name}" failed: ${i.error}` : `Rendered "${i.name}".`);
    }
    return { rendered: job?.completed ?? 0, failed: job?.failed ?? 0 };
  }

  async function improve(n) {
    const errors = [];
    let critique = await getBeatArtworkCritique(projectId, beatId);

    // Phase 1 — coverage: while a requirement has no picture, make those
    // pictures and nothing else.
    const missing = missingRequirements(critique);
    if (missing.length && !state.coverage_blocked) {
      const ids = planRenders(critique, { onlyMissing: true });
      if (ids.length) {
        state.stage = 'coverage';
        const made = await render(ids, critique, n, errors, `for the ${missing.length} requirement${missing.length === 1 ? '' : 's'} with no picture`);
        lastRound = { stage: 'coverage', edited: 0, reverted: 0, rendered: made.rendered, failed: made.failed, errors: errors.slice(0, 5) };
        if (!made.rendered) throw new Error(`No artwork could be rendered${errors.length ? ` (${errors[0]})` : ''}.`);
        return true;
      }
      // Nothing can be rendered for what is missing (dismissed, or the
      // planner drafted nothing): stop waiting on coverage and review what
      // is on file.
      state.coverage_blocked = true;
      note(state, `Coverage cannot be completed automatically: ${missing.length} requirement${missing.length === 1 ? ' has' : 's have'} no picture and no proposal to render (${quoted(missing.map((r) => r.summary))}). Moving on to quality with what is on file.`);
      critique = await critiqueRun([], 'all');
    }

    // Phase 2 — quality: edit what the reviewer says an edit fixes, make
    // again what it says an edit cannot.
    state.stage = 'quality';
    const { edits } = planEdits(critique, state.direction);
    const edited = edits.length ? await runEdits(edits, errors, n) : { kept: 0, reverted: 0, failed: 0 };

    // Renders are planned AFTER the edits: an edit that worked may have
    // settled the requirement, and one that was undone may have used up its
    // artwork's attempts — the critique then drafts the replacement's
    // proposal (no image is looked at again for that).
    critique = edited.reverted ? await critiqueRun([]) : await getBeatArtworkCritique(projectId, beatId);
    const ids = planRenders(critique);
    const made = ids.length ? await render(ids, critique, n, errors, 'to replace pieces the reviewer turned down') : { rendered: 0, failed: 0 };
    lastRound = { stage: 'quality', edited: edited.kept, reverted: edited.reverted, rendered: made.rendered, failed: edited.failed + made.failed, errors: errors.slice(0, 5) };
    if (!edits.length && !ids.length) {
      note(state, 'Nothing left to edit or render.');
      return false;
    }
    if (!made.rendered && !edited.kept && !edited.reverted) {
      throw new Error(`No artwork could be rendered or edited${errors.length ? ` (${errors[0]})` : ''}.`);
    }
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
  const state = createClimbState(KIND, clean, { model, stage: null, coverage_blocked: false, activity: {}, rendering: [], events: [], audit: null });
  registerClimb(KIND, key, state);
  await saveClimb(projectId, key, state);
  setImmediate(() => {
    runArtworkClimb({ projectId, beatId: key, state, discordUser })
      .catch((e) => logger.error(`artwork climb: background run failed: ${e.message}`));
  });
  return state;
}
