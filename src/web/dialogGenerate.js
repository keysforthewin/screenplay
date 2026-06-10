// Dialog auto-generation pipeline.
//
// Triggered from POST /api/dialogs/generate. Returns immediately with a
// job id; the work runs in the background and broadcasts progress to the
// "dialogs:<beatId>" room as each dialog item is persisted.
//
// Pipeline (single-stage, no rendering — text only):
//   1. Anthropic call: given the beat (name/desc/body) plus full character
//      docs for the speakers, WRITE the dialogue the beat needs — capturing
//      its gist in the characters' voices rather than literally transcribing
//      the prose. Returned via the populate_dialog tool, in story order.
//   2. Clear the existing dialogs for the beat, then create one row per
//      returned entry via the gateway. Each create broadcasts a ping.
//
// If the model returns no entries we preserve the user's existing dialogs
// rather than wiping them.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import { buildDialogContext } from './dialogContext.js';
import {
  createDialogViaGateway,
  deleteAllDialogsForBeatViaGateway,
} from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';

const POPULATE_TOOL = {
  name: 'populate_dialog',
  description:
    'Return the dialogue you wrote for this beat as an ordered list. ' +
    'Each entry is one continuous line spoken by one source. Preserve story order.',
  input_schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          "A 2-3 sentence sketch of the scene's dramatic shape BEFORE you write any " +
          'lines: who is present, what each character wants, the central tension, and the ' +
          'turn (the moment something shifts). Write this first — it disciplines the lines ' +
          'that follow so they play the scene rather than narrate the action top-to-bottom.',
      },
      entries: {
        type: 'array',
        description:
          'Ordered list of dialogue entries spoken in this beat, in story order. ' +
          'These should execute the plan you just sketched.',
        items: {
          type: 'object',
          properties: {
            character: {
              type: 'string',
              description:
                "The speaker. Use a roster character's exact name when the speaker is one of them. " +
                'For non-character sources (a radio, TV, intercom, off-screen voice), use a descriptive ' +
                'uppercase label like RADIO, TV ANCHOR, INTERCOM, P.A.. Plain text, no quotation marks.',
            },
            body: {
              type: 'string',
              description:
                'What is spoken. Write it to fit the beat and the speaker\'s voice. ' +
                'No speaker prefix, no quotation marks, no parentheticals, no stage direction.',
            },
          },
          required: ['character', 'body'],
          additionalProperties: false,
        },
      },
    },
    required: ['plan', 'entries'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a screenwriter writing the dialogue for a single beat of a feature film.',
  'Return your result via the populate_dialog tool, in story order.',
  '',
  'Plan first, then write:',
  '- Fill the `plan` field BEFORE the lines. Name who is present, what each character wants, the',
  '  central tension, and the turn. Then write lines that PLAY that scene.',
  '- The beat description and body are GUIDANCE, not a transcript. Capture the gist of the beat in',
  '  the characters\' voices — do not walk the prose sentence by sentence.',
  '',
  'Continuity:',
  '- You are given the story logline, the previous beat, and how its dialogue ended. Let this beat\'s',
  '  opening lines connect to what just happened — pick up the thread rather than restarting cold.',
  '',
  'Voice & character:',
  '- Each speaker gets a bio block. Use it. Match speech patterns, education level, attitude, and',
  '  worldview. If a character has memes / catchphrases, weave them in where they\'d plausibly come',
  '  up — never shoehorn.',
  '',
  'Avoid literalism:',
  '- Do NOT restate the beat description or action lines as dialogue. "Alice walked into the diner"',
  '  is action, not a line for Alice to say.',
  '- Do NOT paraphrase the narrator. Find what the characters would actually say to surface what\'s',
  '  happening, what they want, and how they feel about it.',
  '- Subtext is fine; let characters talk around things rather than naming them.',
  '',
  'Non-character speakers:',
  '- Anyone or anything can speak. If the scene has a radio, TV, intercom, P.A. system, off-screen',
  '  voice, etc., use a descriptive uppercase label as the speaker (RADIO, TV ANCHOR, INTERCOM).',
  '',
  'Length:',
  '- Write enough lines to make the beat work on screen. Don\'t pad with filler. A quick moment may',
  '  need two or three lines; a longer scene may need many more.',
  '',
  'Format:',
  '- `body` is what is spoken — no quotation marks, no speaker prefix, no parentheticals, no stage',
  '  direction.',
  '- `character` is the speaker. For roster characters use the exact roster name; for non-character',
  '  sources use a descriptive uppercase label.',
  '- A single character speaking continuously is one entry; split only when another speaker or a',
  '  clear pause/action interrupts.',
  '',
  'If the beat is pure action with no spoken content, return an empty entries array.',
].join('\n');

// In-memory job tracker. Sufficient for single-process runtime; status survives
// only as long as the process. The SPA polls /api/dialogs/generate/:job_id.
const jobs = new Map();

function makeJobId() {
  return new ObjectId().toString();
}

export function getDialogGenerationJob(jobId) {
  return jobs.get(jobId) || null;
}

export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Dialog work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

export async function startDialogGenerationJob({ beatId }) {
  const beat = await getBeat(undefined, beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }
  const jobId = makeJobId();
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    extracted: 0,
    created: 0,
  };
  jobs.set(jobId, job);
  // Fire and forget; errors are recorded on the job. Holding the per-beat lock
  // for the duration prevents concurrent generates and edit calls from racing
  // the delete-then-recreate window.
  withBeatLock(beat._id, () => runDialogGenerationJob({ job, beat })).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    logger.error(`dialog gen job ${jobId} crashed: ${e.message}`);
  });
  return jobId;
}

async function runDialogGenerationJob({ job, beat }) {
  job.status = 'extracting';
  const entries = await extractEntries({ beat });
  job.extracted = entries.length;
  if (!entries.length) {
    job.status = 'done';
    job.finished_at = new Date();
    logger.warn(
      `dialog gen job ${job.job_id} produced no entries; existing items preserved`,
    );
    return;
  }
  // Clear existing dialogs so the SPA shows an empty list while new items
  // stream in.
  await deleteAllDialogsForBeatViaGateway({ beatId: beat._id });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      // seedFragments populates the y-doc body/character fragments before
      // the gateway broadcasts its ping. The SPA's CollabField for the new
      // dialog therefore mounts against a populated fragment and shows the
      // generated text immediately rather than appearing empty until reload.
      await createDialogViaGateway({
        beatId: beat._id,
        body: entry.body,
        character: entry.character,
        order: i + 1,
        seedFragments: { body: entry.body, character: entry.character },
      });
      job.created += 1;
    } catch (e) {
      logger.warn(
        `dialog gen entry ${i + 1}/${entries.length} failed: ${e.message}`,
      );
    }
  }
  job.status = 'done';
  job.finished_at = new Date();
  logger.info(
    `dialog gen job ${job.job_id} done extracted=${job.extracted} created=${job.created}`,
  );
}

async function extractEntries({ beat }) {
  const context = await buildDialogContext(beat);
  const userText = [
    context,
    '',
    `# This beat — #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    '',
    'Beat description:',
    stripMarkdown(beat.desc || '') || '(none)',
    '',
    'Beat body:',
    stripMarkdown(beat.body || '') || '(none)',
    '',
    'Plan the scene in the `plan` field, then write the dialogue with the populate_dialog tool.',
    'Capture the gist in the characters\' voices, connect to the previous beat, and don\'t restate',
    'action lines as dialogue.',
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: [POPULATE_TOOL],
    tool_choice: { type: 'tool', name: 'populate_dialog' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'populate_dialog',
  );
  if (!toolUse) {
    logger.warn('dialog gen: model did not call populate_dialog');
    return [];
  }
  const entries = Array.isArray(toolUse.input?.entries)
    ? toolUse.input.entries
    : [];
  return entries
    .map((e) => ({
      character: typeof e?.character === 'string' ? e.character.trim() : '',
      body: typeof e?.body === 'string' ? e.body.trim() : '',
    }))
    .filter((e) => e.body && e.character);
}
