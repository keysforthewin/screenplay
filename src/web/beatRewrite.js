// Shared beat-body rewrite core: Normalize (format-only) and Regenerate
// (critique-driven), plus Undo. Both stash the previous body before writing the
// new one through the gateway (so collaborative editors stay in sync) and share
// the single previous_body Undo slot. Uses analyzeText (returns plain text).

import { logger } from '../log.js';
import { analyzeText } from '../llm/analyze.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { getBeatCritique, stashPreviousBody, getPreviousBody, clearPreviousBody } from '../mongo/critiques.js';
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

const REGEN_SYSTEM = [
  'You are a screenwriter revising one beat of a screenplay using a structured critique.',
  'Rewrite the beat body to address the critique comments while preserving the story\'s intent and the characters present.',
  'The rewrite MUST also conform to standard screenplay format per the guide below.',
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

export async function regenerateBeatBody({ beat, critique }) {
  const user = [
    '# Critique to address',
    formatCritiqueForRewrite(critique),
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
  const body = await regenerateBeatBody({ beat, critique });
  await stashPreviousBody(projectId, beat._id, String(beat.body || ''));
  await setBeatBodyViaGateway(projectId, beat._id, body);
  logger.info(`beatRewrite: regenerate beat=${beat._id} chars=${body.length}`);
  return { body };
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
