// Suggests a target storyboard frame count for a beat.
//
// Used by the "Analyze" button on the storyboard generation dialog so the
// director can get an LLM-informed recommendation instead of guessing at the
// default of 11. The model looks at the beat body, description, character
// list, and any free-form director's direction, then picks a number in
// [1, 30] together with a one-sentence rationale.
//
// Failures collapse to { count: null, reason: '<error>' } so callers can fall
// back to the existing count — the dialog never blocks on a miss.

import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';

const MIN_COUNT = 1;
const MAX_COUNT = 30;

const SUGGEST_COUNT_TOOL = {
  name: 'suggest_count',
  description:
    'Recommend how many storyboard frames a beat needs. The number should respect ' +
    'the action density, dialogue count, and length of the beat. A beat that is ' +
    'genuinely one or two shots gets 1-2 frames; a beat with room for embellishment ' +
    '(establishing wides, inserts, reactions, atmospheric cutaways) gets more, and a ' +
    'sprawling one caps out around 30.',
  input_schema: {
    type: 'object',
    properties: {
      count: {
        type: 'integer',
        minimum: MIN_COUNT,
        maximum: MAX_COUNT,
        description: `Recommended number of storyboard frames, in [${MIN_COUNT}, ${MAX_COUNT}].`,
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining the recommendation.',
      },
    },
    required: ['count', 'reason'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a cinematography supervisor estimating how many storyboard frames a screenplay beat needs.',
  '',
  'Pick a number in [1, 30] using the `suggest_count` tool. Use these guidelines:',
  '- A beat that describes exactly one image (a single held moment, a title card, one insert) wants 1 frame. A beat that describes two distinct shots wants 2. Count what the beat actually shows before reaching for a bigger number.',
  '- Tiny beats (a single moment, one location, ≤ 2 characters) usually want 3-6 frames.',
  '- Standard scene beats (a conversation, a small action sequence) usually want 7-12 frames.',
  '- Long or pivotal beats (multi-stage action, montage, location changes) want 13-20 frames.',
  '- Only pick 21-30 when the beat clearly spans several distinct locations or a major action sequence.',
  '',
  'Embellishment shots (an establishing wide, reaction close-ups, atmospheric inserts) are worth counting when the beat has room for them — but never inflate the number to reach a floor. A two-shot beat gets 2, not 3 padded out with coverage nobody asked for.',
  '',
  'If the director attached free-form direction in the user message (e.g. "lean handheld and tight"), respect it: a request for "fast coverage" implies fewer frames, "more breathing room" implies more.',
  '',
  'Return ONLY via the tool call. The `reason` field should be one short sentence the director can read at a glance.',
].join('\n');

function formatCharacterLines(characters) {
  if (!characters?.length) return '(no named characters in this beat)';
  return characters
    .map((c) => {
      const name = stripMarkdown(c.name || '');
      const role = c.fields?.role || c.fields?.description || '';
      return `- ${name}${role ? ` — ${stripMarkdown(role)}` : ''}`;
    })
    .join('\n');
}

export async function analyzeStoryboardCount({
  beat,
  characters = [],
  direction = '',
} = {}) {
  if (!config.anthropic?.apiKey) {
    return { count: null, reason: 'ANTHROPIC_API_KEY not set' };
  }
  if (!beat) {
    return { count: null, reason: 'beat required' };
  }

  const dir = typeof direction === 'string' ? direction.trim() : '';
  const userText = [
    `# Beat #${beat.order ?? '?'}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    '',
    'Beat description:',
    stripMarkdown(beat.desc || '') || '(none)',
    '',
    'Beat body:',
    stripMarkdown(beat.body || '') || '(none)',
    '',
    'Characters in this beat:',
    formatCharacterLines(characters),
    ...(dir
      ? ['', "Director's commentary:", dir]
      : []),
    '',
    'Recommend a frame count via the suggest_count tool.',
  ].join('\n');

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [SUGGEST_COUNT_TOOL],
      tool_choice: { type: 'tool', name: 'suggest_count' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    });
    const toolUse = (resp.content || []).find(
      (b) => b.type === 'tool_use' && b.name === 'suggest_count',
    );
    if (!toolUse?.input) {
      logger.warn(`analyzeStoryboardCount: no tool call (${Date.now() - t0}ms)`);
      return { count: null, reason: 'no_tool_call' };
    }
    const rawCount = Number(toolUse.input.count);
    if (!Number.isFinite(rawCount)) {
      logger.warn(
        `analyzeStoryboardCount: invalid count ${toolUse.input.count} (${Date.now() - t0}ms)`,
      );
      return { count: null, reason: 'invalid_count' };
    }
    const count = Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(rawCount)));
    const reason =
      typeof toolUse.input.reason === 'string' && toolUse.input.reason.trim()
        ? toolUse.input.reason.trim()
        : '';
    logger.info(
      `analyzeStoryboardCount: ${count} in ${Date.now() - t0}ms`,
    );
    return { count, reason };
  } catch (e) {
    logger.warn(`analyzeStoryboardCount: ${e.message} (${Date.now() - t0}ms)`);
    return { count: null, reason: e.message || 'error' };
  }
}
