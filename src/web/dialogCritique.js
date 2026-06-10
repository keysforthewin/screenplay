// Dialogue critic (advisory).
//
// Runs a single LLM-as-judge pass over a beat's dialogue and returns a score
// (1-5) plus a one-line issue for each line. Purely advisory: it persists
// nothing and never regenerates — it just tells the user which lines are weak
// so they know where to click. The model scores lines by their 1-based number;
// we map those back to dialog ids.

import { config } from '../config.js';
import { logger } from '../log.js';
import { listDialogs } from '../mongo/dialogs.js';
import { getBeat } from '../mongo/plots.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import { buildDialogContext } from './dialogContext.js';

const SCORE_TOOL = {
  name: 'score_dialog',
  description: 'Return a score and a short issue note for every numbered line.',
  input_schema: {
    type: 'object',
    properties: {
      scores: {
        type: 'array',
        description: 'One entry per line, by its 1-based line_number.',
        items: {
          type: 'object',
          properties: {
            line_number: { type: 'integer', minimum: 1 },
            score: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: '5 = sharp, natural, in-voice. 1 = wooden, on-the-nose, or filler.',
            },
            issue: {
              type: 'string',
              description:
                'A few words naming the single biggest weakness (e.g. "on-the-nose", ' +
                '"out of voice", "filler", "exposition dump"). Empty string if the line is strong.',
            },
          },
          required: ['line_number', 'score', 'issue'],
          additionalProperties: false,
        },
      },
    },
    required: ['scores'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a dialogue editor reviewing a single beat of a screenplay.',
  '',
  'Score every line 1-5 for how well it works on screen — natural, in the speaker\'s voice,',
  'carrying subtext, earning its place. Penalise on-the-nose lines (characters naming their',
  'feelings/plot), wooden phrasing, filler, and exposition dumps. Reward lines that play the',
  'scene with restraint.',
  '',
  'Return one entry per line via the score_dialog tool, using each line\'s number. Keep the issue',
  'note to a few words; use an empty string for strong lines.',
].join('\n');

export async function critiqueDialog({ beatId } = {}) {
  const beat = await getBeat(undefined, String(beatId));
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  const dialogs = await listDialogs({ beatId: beat._id });
  if (!dialogs.length) return { scores: [] };

  const lineList = dialogs
    .map((d, i) => {
      const speaker = stripMarkdown(d.character || '').trim() || '(unknown)';
      const body = stripMarkdown(d.body || '').trim() || '(empty)';
      return `${i + 1}. ${speaker}: ${body}`;
    })
    .join('\n');

  const context = await buildDialogContext(beat);
  const userText = [
    context,
    '',
    `# This beat — #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    stripMarkdown(beat.desc || '') || '',
    '',
    '# The dialogue to score',
    lineList,
    '',
    'Score every line with the score_dialog tool.',
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [SCORE_TOOL],
    tool_choice: { type: 'tool', name: 'score_dialog' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'score_dialog',
  );
  if (!toolUse) {
    logger.warn('dialog critique: model did not call score_dialog');
    return { scores: [] };
  }
  const raw = Array.isArray(toolUse.input?.scores) ? toolUse.input.scores : [];
  const scores = [];
  for (const s of raw) {
    const n = Number(s?.line_number);
    if (!Number.isInteger(n) || n < 1 || n > dialogs.length) continue;
    const dialog = dialogs[n - 1];
    scores.push({
      dialog_id: dialog._id.toString(),
      score: Number(s.score),
      issue: typeof s.issue === 'string' ? s.issue : '',
    });
  }
  return { scores };
}
