// Shared beat-body rewrite core: Normalize (format-only) and Regenerate
// (critique-driven), plus Undo. Both stash the previous body before writing the
// new one through the gateway (so collaborative editors stay in sync) and share
// the single previous_body Undo slot. Uses analyzeText (returns plain text).

import { logger } from '../log.js';
import { analyzeText } from '../llm/analyze.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { getBeatCritique, setCritiqueStrategy, stashPreviousBody, getPreviousBody, clearPreviousBody } from '../mongo/critiques.js';
import { setBeatBodyViaGateway } from './gateway.js';
import { SCREENPLAY_STYLE_GUIDE } from '../agent/screenplayStyle.js';

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const NORMALIZE_SYSTEM = [
  'You reformat a screenplay beat body to standard screenplay style WITHOUT changing its content, meaning, or events.',
  'Keep every story beat, character, and line; only fix the formatting to follow the guide below.',
  'Return ONLY the reformatted beat body as plain text — no preamble, no commentary, no code fences.',
  '',
  SCREENPLAY_STYLE_GUIDE,
].join('\n');

// Pass 1: reconcile every facet's notes into ONE concrete strategy that targets
// a perfect score in EVERY facet without trading one facet off against another.
const SYNTHESIZE_SYSTEM = [
  'You are a script-editing strategist. You are given one screenplay beat and a set of per-facet critiques, each with a 1-10 score and concrete notes.',
  'Produce ONE concrete, direct rewriting strategy a screenwriter will follow to rewrite the beat.',
  '- Extract EVERY concrete, actionable fix from EVERY facet into a single numbered action plan. Do not drop any fix.',
  '- Reconcile conflicts: where improving one facet could hurt another, state exactly how to satisfy BOTH. The rewrite must RAISE every facet toward a perfect 10 and must NEVER sacrifice one facet to improve another.',
  '- Be specific and directive — name the exact changes (lines to add/cut/reshape, sluglines, blocking, subtext), not vague advice.',
  "- Keep the story's intent and the characters intact.",
  'Output ONLY the numbered strategy. Do NOT write the rewritten beat.',
].join('\n');

// Pass 2: rewrite the beat by executing the strategy, aiming for a perfect score
// in every facet and letting none regress.
const REGEN_SYSTEM = [
  'You are a screenwriter rewriting one beat of a screenplay by fully executing a rewriting strategy.',
  'Execute EVERY item in the strategy. The goal is a PERFECT 10 in every critique facet — raise every weak facet and let no facet regress.',
  "Preserve the story's intent and the characters present. The rewrite MUST conform to standard screenplay format per the guide below.",
  'Return ONLY the rewritten beat body as plain text — no preamble, no commentary, no code fences.',
  '',
  SCREENPLAY_STYLE_GUIDE,
].join('\n');

export async function normalizeBeatBody(body) {
  const out = await analyzeText({
    system: NORMALIZE_SYSTEM,
    user: `Reformat this beat body:\n\n${String(body || '')}`,
    maxTokens: 4000,
  });
  return out.trim();
}

function formatCritiqueForRewrite(critique) {
  const lines = (critique?.facets || [])
    .filter((f) => f.status === 'done' && (f.comments || '').trim())
    .map((f) => `## ${f.label} (score ${f.score ?? '—'}/10)\n${f.comments.trim()}`);
  return lines.length ? lines.join('\n\n') : '(no actionable critique comments)';
}

// Pass 1 — synthesize all facet critiques into one concrete rewrite strategy.
export async function synthesizeRewriteStrategy({ beat, critique }) {
  const user = [
    '# Per-facet critique (each with its 1-10 score and notes)',
    formatCritiqueForRewrite(critique),
    '',
    '# Current beat body',
    String(beat?.body || ''),
  ].join('\n');
  const out = await analyzeText({ system: SYNTHESIZE_SYSTEM, user, maxTokens: 4000 });
  return out.trim();
}

// Pass 2 — rewrite the beat body by executing the synthesized strategy.
export async function regenerateBeatBody({ beat, strategy }) {
  const user = [
    '# Rewrite strategy to execute (every item; aim for a perfect 10 in every facet)',
    String(strategy || ''),
    '',
    '# Current beat body to rewrite',
    String(beat?.body || ''),
  ].join('\n');
  const out = await analyzeText({ system: REGEN_SYSTEM, user, maxTokens: 4000 });
  return out.trim();
}

export async function normalizeBeat(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const body = await normalizeBeatBody(beat.body);
  await stashPreviousBody(projectId, beat._id, String(beat.body || ''));
  await setBeatBodyViaGateway(projectId, beat._id, body);
  logger.info(`beatRewrite: normalize beat=${beat._id} chars=${body.length}`);
  return { body };
}

export async function regenerateBeat(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const critique = await getBeatCritique(projectId, beat._id);
  if (!critique || !(critique.facets || []).some((f) => f.status === 'done')) {
    throw httpError('No critique to regenerate from. Run a critique first.', 409);
  }
  // Pass 1: reconcile every facet into one concrete strategy. Pass 2: rewrite
  // from that strategy. Stash only after both model calls succeed.
  const strategy = await synthesizeRewriteStrategy({ beat, critique });
  const body = await regenerateBeatBody({ beat, strategy });
  await stashPreviousBody(projectId, beat._id, String(beat.body || ''));
  await setBeatBodyViaGateway(projectId, beat._id, body);
  await setCritiqueStrategy(projectId, beat._id, strategy);
  logger.info(`beatRewrite: regenerate beat=${beat._id} strategy_chars=${strategy.length} body_chars=${body.length}`);
  return { body, strategy };
}

export async function restoreBeatBody(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const prev = await getPreviousBody(projectId, beat._id);
  if (prev == null) return { restored: false };
  await setBeatBodyViaGateway(projectId, beat._id, prev);
  await clearPreviousBody(projectId, beat._id);
  logger.info(`beatRewrite: restore beat=${beat._id} chars=${prev.length}`);
  return { restored: true, body: prev };
}
