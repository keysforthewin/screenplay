// "Direction" note generation — the performance note shown to whoever is about
// to voice a line. Each note explains what's happening in the scene at that
// exact moment AND how to deliver the line (intention, subtext, tone), so a
// performer can record straight from the webpage.
//
// Two entry points, mirroring the existing dialogue ops:
//   - generateDirectionForLine — one focused note for a single line, marking it
//     among its neighbours (cf. dialogRegenerate.js).
//   - generateDirectionForBeat — one note per numbered line in a single model
//     call, mapped back to dialog ids by 1-based index (cf. dialogCritique.js).
//
// Neither persists: the route writes the result through the gateway so it lands
// in the dialog's collaborative `direction` field.

import { config } from '../config.js';
import { logger } from '../log.js';
import { getDialog, listDialogs } from '../mongo/dialogs.js';
import { getBeat } from '../mongo/plots.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import { buildDialogContext } from './dialogContext.js';

const SYSTEM_PROMPT = [
  'You are a director giving a voice actor a short performance note for ONE line of a screenplay.',
  '',
  'Write a note (2-4 sentences) that tells the performer:',
  "1. what is happening in the scene at this exact moment — the situation and the emotional temperature; and",
  "2. how to deliver THIS line — the character's intention, what they want, the subtext beneath the words, and the tone/energy.",
  '',
  'Address the performer directly and concretely. Do not quote the line back, do not add parenthetical stage',
  'directions, do not write a preamble — just the note itself.',
].join('\n');

const WRITE_DIRECTION_TOOL = {
  name: 'write_direction',
  description: 'Return the single performance note for the highlighted line.',
  input_schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        description:
          'A 2-4 sentence performance note for the actor voicing the highlighted line: what is ' +
          'happening right now, and how to play this line (intention, subtext, tone).',
      },
    },
    required: ['direction'],
    additionalProperties: false,
  },
};

const WRITE_DIRECTIONS_TOOL = {
  name: 'write_directions',
  description: 'Return one performance note per numbered line.',
  input_schema: {
    type: 'object',
    properties: {
      notes: {
        type: 'array',
        description: 'One entry per line, by its 1-based line_number.',
        items: {
          type: 'object',
          properties: {
            line_number: { type: 'integer', minimum: 1 },
            direction: {
              type: 'string',
              description:
                'A 2-4 sentence performance note for that line: what is happening, and how to play it.',
            },
          },
          required: ['line_number', 'direction'],
          additionalProperties: false,
        },
      },
    },
    required: ['notes'],
    additionalProperties: false,
  },
};

// One focused note for a single line, marking it among its neighbours so the
// model knows exactly which moment it is annotating.
export async function generateDirectionForLine({ projectId, dialogId } = {}) {
  const dialog = await getDialog(projectId, dialogId);
  if (!dialog) throw new Error(`Dialog not found: ${dialogId}`);
  const beat = await getBeat(projectId, dialog.beat_id.toString());
  if (!beat) throw new Error(`Beat not found for dialog ${dialogId}`);

  const all = await listDialogs({ beatId: dialog.beat_id });
  const targetId = dialog._id.toString();
  const speaker = stripMarkdown(dialog.character || '').trim() || '(unknown speaker)';

  // Render the full line list with the target marked, so the model sees the
  // exact lines before and after the one it is writing the note for.
  const lineList = all
    .map((d) => {
      const s = stripMarkdown(d.character || '').trim() || '(unknown)';
      const body = stripMarkdown(d.body || '').trim();
      const marker = d._id.toString() === targetId ? '  <<< WRITE THE NOTE FOR THIS LINE' : '';
      return `${s}: ${body}${marker}`;
    })
    .join('\n');

  const context = await buildDialogContext(projectId, beat);
  const userText = [
    context,
    '',
    `# This beat — #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    stripMarkdown(beat.desc || '') || '',
    '',
    '# The scene as written',
    lineList,
    '',
    `Write the performance note for the line marked "<<< WRITE THE NOTE FOR THIS LINE" — spoken by ` +
      `${speaker}. Use the write_direction tool.`,
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [WRITE_DIRECTION_TOOL],
    tool_choice: { type: 'tool', name: 'write_direction' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'write_direction',
  );
  if (!toolUse) {
    logger.warn('dialog direction: model did not call write_direction');
    return { dialogId: targetId, direction: '' };
  }
  const direction =
    typeof toolUse.input?.direction === 'string' ? toolUse.input.direction.trim() : '';
  return { dialogId: targetId, direction };
}

// One note per line for the whole beat, in a single model call. Maps the
// model's 1-based line numbers back to dialog ids (same scheme as the critic).
export async function generateDirectionForBeat({ projectId, beatId } = {}) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  const dialogs = await listDialogs({ beatId: beat._id });
  if (!dialogs.length) return { notes: [] };

  const lineList = dialogs
    .map((d, i) => {
      const speaker = stripMarkdown(d.character || '').trim() || '(unknown)';
      const body = stripMarkdown(d.body || '').trim() || '(empty)';
      return `${i + 1}. ${speaker}: ${body}`;
    })
    .join('\n');

  const context = await buildDialogContext(projectId, beat);
  const userText = [
    context,
    '',
    `# This beat — #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    stripMarkdown(beat.desc || '') || '',
    '',
    '# The dialogue to annotate',
    lineList,
    '',
    'Write one performance note per numbered line with the write_directions tool.',
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [WRITE_DIRECTIONS_TOOL],
    tool_choice: { type: 'tool', name: 'write_directions' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });

  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'write_directions',
  );
  if (!toolUse) {
    logger.warn('dialog direction: model did not call write_directions');
    return { notes: [] };
  }
  const raw = Array.isArray(toolUse.input?.notes) ? toolUse.input.notes : [];
  const notes = [];
  for (const n of raw) {
    const num = Number(n?.line_number);
    if (!Number.isInteger(num) || num < 1 || num > dialogs.length) continue;
    const direction = typeof n?.direction === 'string' ? n.direction.trim() : '';
    notes.push({ dialog_id: dialogs[num - 1]._id.toString(), direction });
  }
  return { notes };
}
