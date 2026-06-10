// Per-line dialogue regeneration.
//
// Given one dialog line, ask the model for a few fresh alternatives for that
// line — keeping the speaker fixed and every other line in the beat unchanged.
// Read-only: this proposes options, it persists nothing. The caller (SPA)
// shows the alternatives in a picker; applying a choice goes through the
// existing PATCH /dialog/:id → setDialogTextFieldViaGateway path.

import { config } from '../config.js';
import { logger } from '../log.js';
import { getDialog, listDialogs } from '../mongo/dialogs.js';
import { getBeat } from '../mongo/plots.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import { buildDialogContext } from './dialogContext.js';

const ALTERNATIVE_COUNT = 3;

const PROPOSE_TOOL = {
  name: 'propose_alternatives',
  description:
    'Return alternative rewrites for the single highlighted line, spoken by the same character. ' +
    'Each is a complete replacement for that one line.',
  input_schema: {
    type: 'object',
    properties: {
      alternatives: {
        type: 'array',
        description: `Up to ${ALTERNATIVE_COUNT} distinct rewrites of the highlighted line, each in the speaker's voice.`,
        items: { type: 'string' },
      },
    },
    required: ['alternatives'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a screenwriter punching up a single line of dialogue in an existing scene.',
  '',
  `Propose ${ALTERNATIVE_COUNT} distinct, natural alternatives for ONLY the highlighted line, via the`,
  'propose_alternatives tool. Each must:',
  '- be spoken by the same character (do not change the speaker);',
  '- fit the lines immediately before and after it — the rest of the scene is fixed;',
  '- stay in that character\'s voice and serve the moment (subtext over on-the-nose);',
  '- be a different angle from the others, not three rewordings of the same line.',
  '',
  'Return only the spoken words — no speaker prefix, no quotation marks, no parentheticals.',
].join('\n');

export async function generateAlternatives({ dialogId, count = ALTERNATIVE_COUNT } = {}) {
  const dialog = await getDialog(undefined, dialogId);
  if (!dialog) throw new Error(`Dialog not found: ${dialogId}`);
  const beat = await getBeat(undefined, dialog.beat_id.toString());
  if (!beat) throw new Error(`Beat not found for dialog ${dialogId}`);

  const all = await listDialogs({ beatId: dialog.beat_id });
  const targetId = dialog._id.toString();
  const speaker = stripMarkdown(dialog.character || '').trim() || '(unknown speaker)';

  // Render the full line list with the target marked, so the model sees the
  // exact surrounding lines it must fit between.
  const lineList = all
    .map((d) => {
      const s = stripMarkdown(d.character || '').trim() || '(unknown)';
      const body = stripMarkdown(d.body || '').trim();
      const marker = d._id.toString() === targetId ? '  <<< REWRITE THIS LINE' : '';
      return `${s}: ${body}${marker}`;
    })
    .join('\n');

  const context = await buildDialogContext(beat);
  const userText = [
    context,
    '',
    `# This beat — #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    stripMarkdown(beat.desc || '') || '',
    '',
    '# The scene as written',
    lineList,
    '',
    `Rewrite only the line marked "<<< REWRITE THIS LINE" — spoken by ${speaker}. ` +
      `Propose ${count} alternatives with the propose_alternatives tool.`,
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [PROPOSE_TOOL],
    tool_choice: { type: 'tool', name: 'propose_alternatives' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'propose_alternatives',
  );
  if (!toolUse) {
    logger.warn('dialog regen: model did not call propose_alternatives');
    return { dialogId: targetId, character: speaker, alternatives: [] };
  }
  const alternatives = Array.isArray(toolUse.input?.alternatives)
    ? toolUse.input.alternatives
        .map((a) => (typeof a === 'string' ? a.trim() : ''))
        .filter(Boolean)
        .slice(0, count)
    : [];
  return { dialogId: targetId, character: speaker, alternatives };
}
