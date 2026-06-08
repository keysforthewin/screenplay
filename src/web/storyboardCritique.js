// Multi-lens critique panel for storyboard shots. Each lens is an independent
// forced-tool Anthropic call scoring 1–10 with comments; aggregateCritique
// combines them with a strict cap (any lens <= CRITICAL_SCORE pins the overall
// so one hard failure can't be averaged away).

import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { renderSceneBibleBlock } from '../mongo/sceneBible.js';

export const CRITICAL_SCORE = 3;

// The four judging lenses. `key` is persisted; `label` is human-facing; `focus`
// is the one-line system-prompt framing for that lens; `instruction` is the
// reminder injected into the judge's user text.
export const CRITIQUE_LENSES = Object.freeze([
  {
    key: 'bible',
    label: 'Bible adherence',
    focus: 'how faithfully the shot honors the scene bible',
    instruction:
      'Judge ONLY whether the shot honors the scene bible — location, time of day, lighting key, palette, mood, blocking, and camera language. Reward consistency; penalize drift or contradiction.',
  },
  {
    key: 'director_notes',
    label: "Director's-notes adherence",
    focus: "how well the shot respects the project-wide director's notes",
    instruction:
      "Judge ONLY whether the shot respects the project-wide director's notes (global tone / style / continuity directives). If there are no notes, score 8 and say so.",
  },
  {
    key: 'cinematic',
    label: 'Cinematic quality',
    focus: 'the cinematic merit and AI-video readiness of the shot',
    instruction:
      "Judge ONLY cinematic merit and AI-video readiness. START FRAME: is the subject's pose, orientation, heading and placement concrete and correct for the moment (a car squarely in its lane nose-forward, not slewed across the road; a person mid-action, not limp)? Is composition / shot value strong and does the shot earn its place? VIDEO_PROMPT: does it lead with the camera, state ONE directional motion with an endpoint, feature at most one temporal change, end with a stillness constraint, and avoid re-describing the static scene? Penalize ambiguous stills, buried or wandering camera, vague or duplicated motion, and static re-description. Ignore bible/notes adherence (other lenses cover those).",
  },
  {
    key: 'continuity',
    label: 'Continuity',
    focus: 'how cleanly the shot hands off to and from its neighbors',
    instruction:
      'Judge ONLY continuity with the neighbor shots shown — does this shot hand off cleanly (shared subject, matching motion vector, deliberate match cut)? Penalize jarring jumps or drift between neighbors.',
  },
]);

const LENS_KEYS = new Set(CRITIQUE_LENSES.map((l) => l.key));

// Coerce a model-provided score to an integer in [1, 10].
export function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.min(10, Math.max(1, Math.round(v)));
}

// Combine per-lens results into { overall, lowest_lens }. overall = rounded mean,
// but if any lens scored <= CRITICAL_SCORE the overall is capped at the lowest
// such score. lowest_lens names the worst-scoring lens (first one on ties).
export function aggregateCritique(lensResults) {
  const lenses = (Array.isArray(lensResults) ? lensResults : []).filter(
    (l) => l && LENS_KEYS.has(l.lens),
  );
  if (!lenses.length) return { overall: 1, lowest_lens: null };
  const scores = lenses.map((l) => clampScore(l.score));
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  let overall = Math.min(10, Math.max(1, Math.round(mean)));
  const critical = scores.filter((s) => s <= CRITICAL_SCORE);
  if (critical.length) overall = Math.min(overall, ...critical);
  let lowest = lenses[0];
  let lowestScore = clampScore(lenses[0].score);
  for (const l of lenses) {
    const s = clampScore(l.score);
    if (s < lowestScore) {
      lowest = l;
      lowestScore = s;
    }
  }
  return { overall, lowest_lens: lowest.lens };
}

// Hardcoded top-tier model, matching the rest of the storyboard surface.
const CRITIQUE_MODEL = 'claude-opus-4-7';

// Forced-tool schema: every lens judge returns one score + comments.
const JUDGE_TOOL = {
  name: 'judge_shot',
  description: 'Return a 1–10 score and detailed improvement comments for this shot, for your assigned lens only.',
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 10, description: '1 = unusable, 10 = excellent, for your assigned lens only.' },
      comments: { type: 'string', description: 'Specific, actionable notes on what to change/improve for this lens. 1–4 sentences.' },
    },
    required: ['score', 'comments'],
    additionalProperties: false,
  },
};

function formatNeighbor(label, shot) {
  if (!shot) return `${label}: (none)`;
  const sf = stripMarkdown(shot.startFramePrompt || '').trim();
  const summ = stripMarkdown(shot.summary || '').trim();
  return `${label} (shot ${shot.order ?? '?'}): ${summ || '(no summary)'}${sf ? ` | start frame: ${sf}` : ''}`;
}

// Local director-notes formatter (kept here so the module is self-contained).
function formatDirectorNotesForCritique(directorNotes) {
  if (!Array.isArray(directorNotes) || !directorNotes.length) return null;
  const items = directorNotes
    .map((n) => stripMarkdown(typeof n?.text === 'string' ? n.text : '').trim())
    .filter(Boolean);
  return items.length ? items.map((t) => `- ${t}`).join('\n') : null;
}

// Shared context block every lens judge sees for one shot.
export function buildShotCritiqueContext({ sceneBible, directorNotes, shot, prevShot, nextShot }) {
  const lines = [];
  const bibleBlock = renderSceneBibleBlock(sceneBible);
  if (bibleBlock) lines.push('# Scene bible (the agreed look):', bibleBlock, '');
  const notes = formatDirectorNotesForCritique(directorNotes);
  if (notes) lines.push("# Director's notes (project-wide):", notes, '');
  lines.push(
    '# Shot under review:',
    `order: ${shot.order ?? '?'}`,
    `shot_type: ${shot.shot_type || '(unset)'}`,
    `summary: ${stripMarkdown(shot.summary || '').trim() || '(none)'}`,
    `prompt (video/action): ${stripMarkdown(shot.text_prompt || '').trim() || '(none)'}`,
    `start-frame prompt: ${stripMarkdown(shot.startFramePrompt || '').trim() || '(none)'}`,
    '',
    '# Neighbors (for continuity):',
    formatNeighbor('Previous', prevShot),
    formatNeighbor('Next', nextShot),
  );
  return lines.join('\n');
}

let lensJudgeOverride = null;
export function _setLensJudgeForTests(fn) {
  lensJudgeOverride = fn;
}

// Run ONE lens judge. target is 'prompt' | 'image'. On the image tier,
// imageInput {buffer, contentType} is attached as a base64 image block.
async function runLensJudge({ lens, target, context, imageInput }) {
  if (lensJudgeOverride) return lensJudgeOverride({ lens, target, context, imageInput });
  const system = [
    `You are a strict film director reviewing ONE storyboard shot through a single lens: ${lens.focus}.`,
    lens.instruction,
    'Score 1–10 (1 = unusable, 10 = excellent) and give specific, actionable comments. Be exacting; do not inflate scores.',
    target === 'image'
      ? 'You are judging the RENDERED START-FRAME IMAGE attached below against the shot description and the context.'
      : 'You are judging the WRITTEN PROMPTS (no image yet) against the context.',
    'Return your verdict via the judge_shot tool.',
  ].join('\n');
  const content = [{ type: 'text', text: context }];
  if (target === 'image' && imageInput?.buffer && imageInput?.contentType) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: imageInput.contentType, data: imageInput.buffer.toString('base64') },
    });
  }
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: CRITIQUE_MODEL,
    max_tokens: 1024,
    system,
    tools: [JUDGE_TOOL],
    tool_choice: { type: 'tool', name: 'judge_shot' },
    messages: [{ role: 'user', content }],
  });
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(`storyboard critique: lens ${lens.key} hit max_tokens; treating as no verdict`);
    return { score: 1, comments: '(judge response truncated)', error: true };
  }
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'judge_shot');
  if (!toolUse?.input) {
    logger.warn(`storyboard critique: lens ${lens.key} returned no tool call`);
    return { score: 1, comments: '(judge produced no verdict)', error: true };
  }
  return {
    score: toolUse.input.score,
    comments: typeof toolUse.input.comments === 'string' ? toolUse.input.comments : '',
  };
}

// Run all four lenses (in parallel) for one shot and aggregate. Returns the
// persisted critique shape.
export async function critiquePanel({ target, sceneBible, directorNotes, shot, prevShot, nextShot, imageInput = null }) {
  const context = buildShotCritiqueContext({ sceneBible, directorNotes, shot, prevShot, nextShot });
  const lensResults = await Promise.all(
    CRITIQUE_LENSES.map(async (lens) => {
      try {
        const { score, comments, error } = await runLensJudge({ lens, target, context, imageInput });
        const out = { lens: lens.key, score: clampScore(score), comments: String(comments || '') };
        if (error) out.error = true;
        return out;
      } catch (e) {
        logger.warn(`storyboard critique: lens ${lens.key} failed: ${e?.message || e}`);
        return { lens: lens.key, score: 1, comments: `(lens failed: ${e?.message || e})`, error: true };
      }
    }),
  );
  // Errored lenses are kept in the result for transparency but excluded from the
  // aggregate so a transient API failure can't paint a shot as critically bad.
  const scored = lensResults.filter((l) => !l.error);
  const { overall, lowest_lens } = aggregateCritique(scored);
  return { overall, lowest_lens, lenses: lensResults, model: CRITIQUE_MODEL, created_at: new Date(), target };
}
