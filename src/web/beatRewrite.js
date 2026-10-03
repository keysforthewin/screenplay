// Shared beat-body rewrite core: Normalize (format-only) and Regenerate
// (critique-driven), plus Undo. Both stash the previous body before writing the
// new one through the gateway (so collaborative editors stay in sync) and share
// the single previous_body Undo slot.
//
// Regenerate is what the Climb loops on (critiqueClimb.js), in one of two modes:
//   rewrite — a strategist orders the critique into a plan, then a writer
//             rewrites the whole body from the plan AND the critique itself;
//   edit    — one structured call returns find/replace corrections for the
//             passages at fault, applied in code (applyBeatEdits), so text the
//             critique did not fault cannot change.
// Every call is given what the critics score against (`ctx`, from
// buildCritiqueContext: scene bible, director's notes, voice, dialogue style,
// character profiles, sets, neighbours) — a writer who cannot see the scene
// bible fixes the pacing and gets the boy's age wrong.

import { logger } from '../log.js';
import { analyzeText } from '../llm/analyze.js';
import { getAnthropic } from '../anthropic/client.js';
import { resolveProjectId } from '../mongo/projects.js';
import { getBeat } from '../mongo/plots.js';
import { getBeatCritique, setCritiqueStrategy, stashPreviousBody, getPreviousBody, clearPreviousBody } from '../mongo/critiques.js';
import { setBeatBodyViaGateway } from './gateway.js';
import { SCREENPLAY_STYLE_GUIDE } from '../agent/screenplayStyle.js';
import { modelFor } from '../llm/modelSlots.js';
import {
  FACETS,
  getFacet,
  notesText,
  charactersFullText,
  setsText,
  neighborBlock,
  spineText,
  plainText,
} from './critiqueFacets.js';
import { buildCritiqueContext } from './critiqueContext.js';
import { collectRankedIssues, scoreLevers, SEVERITY_ORDER } from './critiqueScoring.js';
import { hardBreaksToLines, linesToHardBreaks } from '../util/markdown.js';

const STRATEGY_MAX_TOKENS = 6000;
const REWRITE_MAX_TOKENS = 16000;
const EDITS_MAX_TOKENS = 16000;

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── The page, in and out ──
// The stored body is markdown, where a line break inside a paragraph has to
// be a hard break or the editor joins the lines — "KEYS / (flat) /
// Compliance." written with bare newlines is saved as one line, and the
// format critic then (rightly) faults the dialogue layout. So every writer
// call is shown the page with plain line breaks (`pageOf`), writes plain line
// breaks back, and the result goes through `toStoredBody` before it is saved.
export const pageOf = (body) => hardBreaksToLines(body).trim();
export const toStoredBody = (page) => linesToHardBreaks(page);

const LAYOUT_RULE = 'Layout: one blank line between paragraphs. A slugline, a mini-slug, a shot cue and a transition each get a line of their own. Dialogue is a block of consecutive lines with no blank line inside it — the character cue in CAPS on its own line, an optional (parenthetical) on the next, then the speech — and a blank line after. Line breaks are kept exactly as you write them.';

// Every criterion the critics score, with what earns a 9. The writer is
// marked against all of these, so the writer is shown all of them.
function rubricText() {
  const out = ['# What the critics score (each criterion, and what earns a 9)'];
  for (const f of FACETS) {
    out.push(`## ${f.label}`);
    for (const c of f.criteria || []) out.push(`- ${c.label}: ${c.anchors[9]}`);
  }
  return out.join('\n');
}
const RUBRIC = rubricText();

const NORMALIZE_SYSTEM = [
  'You reformat a screenplay beat body to standard screenplay style WITHOUT changing its content, meaning, or events.',
  'Keep every story beat, character, and line; only fix the formatting to follow the guide below.',
  LAYOUT_RULE,
  'Return ONLY the reformatted beat body as plain text — no preamble, no commentary, no code fences.',
  '',
  SCREENPLAY_STYLE_GUIDE,
].join('\n');

// How the score is built, said once to every call that plans a change. The
// numbers are deriveFacetScore's (critiqueScoring.js).
const SCORE_MECHANICS = 'How the score works: each facet is the mean of its criteria, then capped by its issues — one MUST FIX caps the facet at 7, two cap it at 5, and three or more SHOULD FIX cap it at 8. The "Score levers" table says which cap binds each facet and what lifting it is worth to the overall score. A facet stays capped until its must-fix issues are ALL gone and it holds at most two should-fix issues, so half-clearing a facet gains nothing.';

const FIXED_FACTS_RULE = 'The documents under "What this beat must agree with" are fixed facts: ages, time of day, light, the layout of a set, who knows what, and what the director\'s notes ask for. Never contradict them. Where an issue\'s suggested fix would, find a fix that satisfies both. Clothing has an order of authority: a wardrobe set for this beat and what the scene bible says people wear come first; a character\'s usual wardrobe is only the default for when the scene says nothing, so a character dressed for the scene\'s weather, season or place is correct and is not changed back to the default.';

// Pass 1: order the critique into ONE plan that lifts the caps without
// trading one facet off against another.
const SYNTHESIZE_SYSTEM = [
  'You are a script-editing strategist. You are given one screenplay beat, the documents it must agree with, and its critique: a table of score levers, the issues ranked by severity (each quoting the line, naming the problem and a fix), per-facet criterion scores, and what the critics praised.',
  'Produce ONE numbered plan a screenwriter will follow to rewrite the beat.',
  SCORE_MECHANICS,
  '- Work down the levers table: the facet worth the most comes first.',
  '- Every MUST FIX issue gets its own numbered step that quotes the line it changes and gives the replacement.',
  '- In every facet holding three or more SHOULD FIX issues, resolve enough of them to leave two at most, and resolve the others, and the NITS, wherever that costs nothing in another facet.',
  '- Then EVERY facet gets a step, not only the capped or low ones: "Targets" lists each criterion short of a 9 with what its 9 looks like. For each facet listed there, name the concrete change that moves its criteria toward that 9 — a facet at 8 with no issue still has a step. Only a facet with nothing under "Targets" is left alone.',
  `- ${FIXED_FACTS_RULE}`,
  '- Where two facets pull against each other, say how to serve both: a detail one critic wants and another calls clutter is said in fewer words, or moved to where it does not stall the action. A rewrite that raises one facet by lowering another is a net loss.',
  '- End with a "Leave alone" list: the lines and choices the critics named as strengths, which the rewrite must keep word for word.',
  '- Be specific and directive — name the exact changes (lines to add, cut or reshape, sluglines, blocking, subtext), not general advice.',
  "- Keep the story's intent and the characters intact. An issue whose fix lies outside this beat (a neighbouring beat, the beat's place in the story) is noted as out of reach, not forced into the text.",
  'Output ONLY the numbered plan. Do NOT write the rewritten beat.',
  '',
  RUBRIC,
].join('\n');

// Pass 2: rewrite the beat from the plan and the critique itself.
const REGEN_SYSTEM = [
  'You are a screenwriter rewriting one beat of a screenplay from its critique.',
  'You are given the documents the beat must agree with, the critique (each issue quotes a line and gives a fix), a plan that orders the issues and settles the conflicts between them, and the current beat.',
  '- Resolve every MUST FIX and every SHOULD FIX issue. Where the plan and an issue\'s own fix differ, follow the plan.',
  '- Change only what an issue or the plan calls for — the plan has a step for every facet short of a 9, and each of those steps is carried out, not only the fixes. A line neither an issue nor the plan names stays as written, word for word, and so does everything on the plan\'s "Leave alone" list and under "Keep".',
  `- ${FIXED_FACTS_RULE}`,
  '- Add nothing a fix does not need — no new props, wardrobe inventories, camera moves or lines of dialogue. Additions are where new faults come from, and the next critique will count them.',
  "- Preserve the story's intent and the characters present. The rewrite MUST conform to standard screenplay format per the guide below.",
  `- ${LAYOUT_RULE}`,
  'Return ONLY the rewritten beat body as plain text — no preamble, no commentary, no code fences.',
  '',
  SCREENPLAY_STYLE_GUIDE,
  '',
  RUBRIC,
].join('\n');

// Edit mode: corrections to the passages at fault or short of a 9, nothing else.
const EDITS_SYSTEM = [
  'You are a screenwriter making targeted corrections to one beat of a screenplay from its critique. The beat already scores well, and a full rewrite would put its strong lines at risk, so you change only the passages that are at fault or that hold a facet short of a 9.',
  'You are given the documents the beat must agree with, the critique (a table of score levers, each issue quoting a line with a fix, then "Targets": every criterion short of a 9 with what its 9 looks like), and the current beat body.',
  SCORE_MECHANICS,
  'Return a plan and a list of edits. Each edit replaces one passage of the body:',
  '- find: copied character for character from the current beat body exactly as shown, markdown marks included. Keep it within one line where you can; long enough to occur exactly once in the body; no longer than the correction needs.',
  '- replace: the corrected text. An empty string cuts the passage.',
  '- issue: the critique issue it resolves, in a few words.',
  'Rules:',
  '- Resolve every MUST FIX. In every facet holding three or more SHOULD FIX issues, resolve enough to leave two at most; resolve the others, and the NITS, where it costs nothing in another facet. Work down the levers table.',
  '- Then improve EVERY facet, not only the capped or low ones: for each facet with a criterion under "Targets", make the edits that move it toward its 9. A facet at 8 with no issue still gets an edit where one passage holds it back; say in the plan which facet each such edit serves.',
  `- ${FIXED_FACTS_RULE}`,
  '- Edits are applied in order and must not overlap. To move text, cut it with one edit and insert it with another (find the line it should follow; replace with that line plus the moved text).',
  '- To insert, find the line before the insertion point and replace it with itself plus the new text.',
  '- Add nothing a fix or a target does not need. Edit only a passage an issue names or a target calls for; everything under "Keep" stays word for word.',
  '- The corrected text follows standard screenplay format per the guide below.',
  `- ${LAYOUT_RULE} A cue, parenthetical or speech that shares a line with another is itself a fault to correct: replace the line with the same words on separate lines.`,
  '- An issue whose fix lies outside this beat gets no edit; name it in the plan as out of reach.',
  'plan: a short numbered list of what you changed and why, in the order of the edits, then any issue you left and why.',
  '',
  SCREENPLAY_STYLE_GUIDE,
  '',
  RUBRIC,
].join('\n');

const EDITS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'edits'],
  properties: {
    plan: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['find', 'replace', 'issue'],
        properties: {
          find: { type: 'string', description: 'Verbatim from the current beat body; occurs exactly once' },
          replace: { type: 'string', description: 'The corrected text; empty to cut' },
          issue: { type: 'string', description: 'The critique issue this resolves' },
        },
      },
    },
  },
};

const textOf = (resp) => (resp?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

// One plain-text call on the critique slot. Unlike analyzeText it sees the
// stop reason: a rewrite cut off at the token limit must fail, not be scored.
async function callText({ system, user, maxTokens, label }) {
  const resp = await getAnthropic().messages.create({
    model: modelFor('critique'),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (resp?.stop_reason === 'max_tokens') throw new Error(`The ${label} was cut off at the length limit.`);
  return textOf(resp);
}

export async function normalizeBeatBody(body) {
  const out = await analyzeText({
    model: modelFor('critique'),
    system: NORMALIZE_SYSTEM,
    user: `Reformat this beat body:\n\n${pageOf(body)}`,
    maxTokens: 8000,
  });
  return toStoredBody(out);
}

const SEVERITY_HEADINGS = { must_fix: 'MUST FIX', should_fix: 'SHOULD FIX', nit: 'NITS' };

// The critique as the strategist reads it: every issue ranked by severity
// (quote → problem → fix), then each facet's criterion scores and summary.
// Pre-v2 critiques (no issues anywhere) fall back to the score + comments list.
export function formatCritiqueForRewrite(critique) {
  const done = (critique?.facets || []).filter((f) => f.status === 'done');
  const ranked = collectRankedIssues(critique, FACETS);
  if (!ranked.length) {
    const lines = done
      .filter((f) => (f.comments || '').trim())
      .map((f) => `## ${f.label} (score ${f.score ?? '—'}/10)\n${f.comments.trim()}`);
    return lines.length ? lines.join('\n\n') : '(no actionable critique comments)';
  }
  const out = ['# Ranked issues (fix in this order)'];
  for (const sev of SEVERITY_ORDER) {
    const group = ranked.filter((i) => i.severity === sev);
    if (!group.length) continue;
    out.push('', `## ${SEVERITY_HEADINGS[sev]}`);
    for (const i of group) {
      const where = i.criterion ? `${i.facet_label} / ${i.criterion}` : i.facet_label;
      const quote = i.quote ? ` "${i.quote}"` : '';
      out.push(`- [${where}]${quote} — ${i.problem}${i.fix ? ` → FIX: ${i.fix}` : ''}`);
    }
  }
  out.push('', '# Facet summaries');
  for (const f of done) {
    out.push('', `## ${f.label} (score ${f.score ?? '—'}/10)`);
    for (const c of f.criteria || []) {
      out.push(`- ${c.label || c.key}: ${c.applicable === false ? 'n/a' : `${c.score ?? '—'}/10`}`);
    }
    const summary = (f.summary || f.comments || '').trim();
    if (summary) out.push(summary);
  }
  return out.join('\n');
}

const BINDING_TEXT = {
  two_must_fix: 'capped at 5 by two or more must-fix issues',
  one_must_fix: 'capped at 7 by a must-fix issue',
  three_should_fix: 'capped at 8 by three or more should-fix issues',
};

// Where the points are: one line per facet, the most valuable first.
export function formatScoreLevers(critique) {
  const levers = scoreLevers(critique, FACETS);
  if (!levers.length) return [];
  const out = ['# Score levers (most valuable first)'];
  for (const l of levers) {
    const counts = `${l.must_fix} must-fix, ${l.should_fix} should-fix`;
    if (l.binding) {
      out.push(`- ${l.facet_label}: ${l.score}/10 now, ${BINDING_TEXT[l.binding]} (${counts}). Its criteria average ${l.uncapped} — clearing the cap is worth +${l.gain} overall.`);
    } else {
      out.push(`- ${l.facet_label}: ${l.score}/10, no cap binding (${counts}). It rises only by raising its lowest criteria${l.lowest.length ? `: ${l.lowest.map((c) => `${c.label} ${c.score}`).join(', ')}` : ''}.`);
    }
  }
  out.push('');
  return out;
}

const KEEP_FROM = 9;

// What a 9 looks like for every criterion that is short of it, in every
// facet — a rewrite aims at all of them, not only the low ones.
export function formatTargets(critique) {
  const out = [];
  for (const f of critique?.facets || []) {
    if (f.status !== 'done') continue;
    const def = getFacet(f.key);
    for (const c of f.criteria || []) {
      if (c.applicable === false || c.score == null || c.score >= KEEP_FROM) continue;
      const anchor = def?.criteria?.find((d) => d.key === c.key)?.anchors?.[9];
      if (anchor) out.push(`- ${f.label} / ${c.label || c.key} (now ${c.score}): a 9 is — ${anchor}`);
    }
  }
  return out.length ? ['# Targets (every criterion short of a 9, and what the critics score a 9)', ...out, ''] : [];
}

// What the critics praised: strengths, and the lines quoted as evidence for a
// criterion at 9 or 10. A rewrite that loses these loses points it already had.
export function formatKeepList(critique) {
  const out = [];
  for (const f of critique?.facets || []) {
    if (f.status !== 'done') continue;
    for (const s of f.strengths || []) out.push(`- [${f.label}] ${s}`);
    for (const c of f.criteria || []) {
      if (c.applicable === false || (c.score ?? 0) < KEEP_FROM) continue;
      for (const e of c.evidence || []) {
        if (e.quote) out.push(`- [${f.label} / ${c.label || c.key}, scored ${c.score}] "${e.quote}"`);
      }
    }
  }
  return out.length ? ['# Keep (the critics praised these — do not change them)', ...out, ''] : [];
}

// Everything the critics score the beat against, as one block. `ctx` is
// buildCritiqueContext's; null (older callers, tests) yields nothing.
export function formatRewriteContext(ctx) {
  if (!ctx) return [];
  const section = (title, text) => (text ? [`## ${title}`, text, ''] : []);
  const out = [
    '# What this beat must agree with (fixed — the rewrite may not contradict any of it)',
    ...section('What this beat is for (its description)', plainText(ctx.beat?.desc)),
    ...section('Scene bible for this beat', plainText(ctx.sceneBible)),
    ...section('Beat-level direction', plainText(ctx.beat?.dialog_notes)),
    ...section("Director's notes (project-wide)", (ctx.directorNotes || []).length ? notesText(ctx.directorNotes) : ''),
    ...section('Directorial voice', plainText(ctx.directorialVoice)),
    ...section('Project dialogue style', plainText(ctx.plot?.dialogue_style)),
    ...section('Characters in this beat', (ctx.characters || []).length ? charactersFullText(ctx.characters, ctx.beat) : ''),
    ...section('Sets linked to this beat', (ctx.sets || []).length ? setsText(ctx.sets) : ''),
    ...section('Story spine', (ctx.spine || []).length ? spineText(ctx.spine) : ''),
    ...section('The beat before this one (this beat picks up from it and must not replay it)', ctx.prevBeat ? neighborBlock('PREVIOUS beat', ctx.prevBeat) : ''),
    ...section('The beat after this one (this beat hands off to it)', ctx.nextBeat ? neighborBlock('NEXT beat', ctx.nextBeat) : ''),
  ];
  return out.length > 1 ? out : [];
}

function directionBlock(direction) {
  const text = String(direction || '').trim();
  if (!text) return [];
  return [
    "# The director's direction for this rewrite",
    text,
    'Follow it. Where it pulls against a critique note, the direction wins; serve the note as far as the direction allows.',
    '',
  ];
}

const MAX_HISTORY_STRATEGY_CHARS = 1500;
const MAX_HISTORY_ISSUES = 12;

// The must-fix and should-fix issues of a critique, one line each — what the
// critics said about a rewrite that was then discarded.
export function summarizeIssuesForHistory(critique) {
  return collectRankedIssues(critique, FACETS)
    .filter((i) => i.severity !== 'nit')
    .slice(0, MAX_HISTORY_ISSUES)
    .map((i) => `[${i.facet_label}, ${SEVERITY_HEADINGS[i.severity].toLowerCase()}]${i.quote ? ` "${i.quote}"` : ''} — ${i.problem}`);
}

// history: earlier climb attempts from this same body that did not raise the
// score — [{n, score, mode, facets: {label: score}, strategy, issues: [line]}].
function historyBlock(history) {
  if (!history?.length) return [];
  const out = [
    '# Earlier attempts on this same body that did NOT raise the score',
    'Each plan below was carried out in full and the result was critiqued again; it scored no higher, so it was discarded and the body below is unchanged. Under each are the faults the critics found in that attempt — faults it introduced or left. Do not repeat these plans: keep what they got right, and avoid what they broke.',
  ];
  for (const h of history) {
    const facets = Object.entries(h.facets || {}).map(([label, score]) => `${label} ${score}`).join(', ');
    out.push('', `## Attempt ${h.n}${h.mode ? ` (${h.mode === 'edit' ? 'targeted edits' : 'full rewrite'})` : ''}: overall ${h.score}/10${facets ? ` (${facets})` : ''}`);
    const strategy = String(h.strategy || '').trim();
    if (strategy) out.push(strategy.length > MAX_HISTORY_STRATEGY_CHARS ? `${strategy.slice(0, MAX_HISTORY_STRATEGY_CHARS)}…` : strategy);
    if (h.issues?.length) out.push('What the critics then faulted:', ...h.issues.map((line) => `- ${line}`));
  }
  out.push('');
  return out;
}

function critiqueBlocks(critique) {
  return [
    ...formatScoreLevers(critique),
    '# Critique (ranked issues, then per-facet scores and notes)',
    formatCritiqueForRewrite(critique),
    '',
    ...formatTargets(critique),
    ...formatKeepList(critique),
  ];
}

// Pass 1 — order the critique into one concrete plan. `ctx` is the critics'
// source material, `direction` the human's steer, `history` the discarded
// attempts of a climb; all optional.
export async function synthesizeRewriteStrategy({ beat, critique, ctx = null, direction = '', history = [] }) {
  const user = [
    ...formatRewriteContext(ctx),
    ...directionBlock(direction),
    ...historyBlock(history),
    ...critiqueBlocks(critique),
    '# Current beat body',
    pageOf(beat?.body),
  ].join('\n');
  return callText({ system: SYNTHESIZE_SYSTEM, user, maxTokens: STRATEGY_MAX_TOKENS, label: 'rewrite plan' });
}

// Pass 2 — rewrite the beat body from the plan and the critique.
export async function regenerateBeatBody({ beat, strategy, critique = null, ctx = null, direction = '' }) {
  const user = [
    ...formatRewriteContext(ctx),
    ...directionBlock(direction),
    ...(critique ? ['# Critique (each issue quotes the line at fault and gives a fix)', formatCritiqueForRewrite(critique), '', ...formatTargets(critique), ...formatKeepList(critique)] : []),
    '# The plan (follow it; it orders the issues and settles the conflicts between them)',
    String(strategy || ''),
    '',
    '# Current beat body to rewrite',
    pageOf(beat?.body),
  ].join('\n');
  return toStoredBody(await callText({ system: REGEN_SYSTEM, user, maxTokens: REWRITE_MAX_TOKENS, label: 'rewrite' }));
}

// Edit mode — one structured call: a plan and find/replace corrections.
// Returns {plan, edits: [{find, replace, issue}]}; apply with applyBeatEdits.
export async function planBeatEdits({ beat, critique, ctx = null, direction = '', history = [] }) {
  const user = [
    ...formatRewriteContext(ctx),
    ...directionBlock(direction),
    ...historyBlock(history),
    ...critiqueBlocks(critique),
    '# Current beat body (copy every `find` from here, character for character)',
    pageOf(beat?.body),
  ].join('\n');
  const ask = () => getAnthropic().messages.create({
    model: modelFor('critique'),
    max_tokens: EDITS_MAX_TOKENS,
    system: EDITS_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: EDITS_SCHEMA } },
    messages: [{ role: 'user', content: user }],
  });
  const parse = (r) => { try { return JSON.parse(textOf(r)); } catch { return null; } };
  let resp = await ask();
  if (resp?.stop_reason === 'max_tokens') throw new Error('The edit list was cut off at the length limit.');
  let parsed = parse(resp);
  if (!parsed) {
    logger.warn(`beatRewrite: edit plan returned no JSON (stop_reason ${resp?.stop_reason || '?'}); asking again`);
    resp = await ask();
    parsed = parse(resp);
  }
  if (!parsed) throw new Error('The model did not return an edit list.');
  return {
    plan: String(parsed.plan || '').trim(),
    edits: (Array.isArray(parsed.edits) ? parsed.edits : [])
      .filter((e) => e && typeof e.find === 'string' && typeof e.replace === 'string')
      .map((e) => ({ find: e.find, replace: e.replace, issue: String(e.issue || '').trim() })),
  };
}

// Apply find/replace edits in order, on the page form of the body (the form
// the planner was shown), and return the result in stored form. An edit is
// skipped — never guessed at — when its `find` is empty, absent or occurs
// more than once in the body as it then stands, or when it changes nothing.
// Pure.
export function applyBeatEdits(body, edits) {
  let text = pageOf(body);
  const applied = [];
  const skipped = [];
  for (const edit of edits || []) {
    const find = String(edit?.find ?? '');
    const replace = String(edit?.replace ?? '');
    let reason = null;
    if (!find.trim()) reason = 'empty';
    else if (find === replace) reason = 'no_change';
    else {
      const first = text.indexOf(find);
      if (first < 0) reason = 'not_found';
      else if (text.indexOf(find, first + find.length) >= 0) reason = 'ambiguous';
      else text = text.slice(0, first) + replace + text.slice(first + find.length);
    }
    if (reason) skipped.push({ ...edit, reason });
    else applied.push(edit);
  }
  return { body: toStoredBody(text), applied, skipped };
}

// The edit plan as stored in `critique.strategy` and shown in the UI.
export function describeEditPlan({ plan, applied = [], skipped = [] }) {
  const out = [`Targeted edits (${applied.length} applied${skipped.length ? `, ${skipped.length} could not be placed` : ''}).`];
  if (plan) out.push('', plan);
  if (skipped.length) {
    out.push('', 'Not applied:', ...skipped.map((e) => `- ${e.issue || 'edit'} (${e.reason === 'ambiguous' ? 'the passage occurs more than once' : e.reason === 'not_found' ? 'the passage was not found in the body' : 'nothing to change'})`));
  }
  return out.join('\n');
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

// The critics' source material for a beat; a failure costs the rewrite its
// context, not the rewrite.
export async function loadRewriteContext(projectId, beat) {
  try {
    return await buildCritiqueContext(projectId, beat);
  } catch (e) {
    logger.warn(`beatRewrite: could not load the rewrite context: ${e.message}`);
    return null;
  }
}

export async function regenerateBeat(projectId, beatId) {
  projectId = await resolveProjectId(projectId);
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw httpError(`beat not found: ${beatId}`, 404);
  const critique = await getBeatCritique(projectId, beat._id);
  if (!critique || !(critique.facets || []).some((f) => f.status === 'done')) {
    throw httpError('No critique to regenerate from. Run a critique first.', 409);
  }
  // Pass 1: order the critique into one concrete plan. Pass 2: rewrite from
  // the plan and the critique. Stash only after both model calls succeed.
  const ctx = await loadRewriteContext(projectId, beat);
  const strategy = await synthesizeRewriteStrategy({ beat, critique, ctx });
  const body = await regenerateBeatBody({ beat, strategy, critique, ctx });
  if (!body) throw new Error('The rewrite came back empty.');
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
