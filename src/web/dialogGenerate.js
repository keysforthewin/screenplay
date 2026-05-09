// Dialog auto-generation pipeline.
//
// Triggered from POST /api/dialogs/generate. Returns immediately with a
// job id; the work runs in the background and broadcasts progress to the
// "dialogs:<beatId>" room as each dialog item is persisted.
//
// Pipeline (single-stage, no rendering — text only):
//   1. Anthropic call: scan the beat body / desc / characters and emit every
//      spoken line via the populate_dialog tool, in story order.
//   2. Clear the existing dialogs for the beat, then create one row per
//      returned entry via the gateway. Each create broadcasts a ping.
//
// If the model returns no entries we preserve the user's existing dialogs
// rather than wiping them.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { listCharacters } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import {
  createDialogViaGateway,
  deleteAllDialogsForBeatViaGateway,
} from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';

const POPULATE_TOOL = {
  name: 'populate_dialog',
  description:
    'Extract every line of spoken dialog from the beat into an ordered list. ' +
    'Each entry is one continuous line spoken by one character. Preserve story order.',
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        description:
          'Ordered list of dialog entries spoken in this beat, in story order.',
        items: {
          type: 'object',
          properties: {
            character: {
              type: 'string',
              description:
                "The speaker's name — match an existing character name from the list when possible. " +
                'Plain text, no quotation marks.',
            },
            body: {
              type: 'string',
              description:
                'What the character says, exactly. No speaker prefix, no quotation marks, no stage direction.',
            },
          },
          required: ['character', 'body'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a screenplay editor. Extract every line of spoken dialog from the beat below, in story order.',
  'Return your result via the populate_dialog tool.',
  'Output only the dialog the characters speak — narration, action, and stage directions are NOT dialog.',
  "Preserve each speaker's name as it appears; if a known character name from the project's roster matches, use that exact name.",
  '`body` is what the character says (no quotation marks, no speaker prefix); `character` is the speaker.',
  '',
  'Edge cases:',
  '- Parentheticals inside a line are stage direction. Strip them: "(angrily) Get out!" → body "Get out!".',
  '- Off-screen / voice-over speech (V.O., O.S., CONT\'D, etc.) IS dialog. Drop the qualifier from the speaker name.',
  '- A single character speaking continuously is one entry. Only split when an action beat, scene break, or another speaker interrupts.',
  '',
  'If the beat contains no spoken dialog, return an empty entries array.',
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
  const beat = await getBeat(beatId);
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
  const characterDocs = await loadCharacterDocs(beat.characters || []);
  const entries = await extractEntries({ beat, characters: characterDocs });
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

async function loadCharacterDocs(characterNames) {
  // Preferred order: characters listed on the beat first, then everyone else.
  const seen = new Set();
  const out = [];
  const all = await listCharacters().catch(() => []);
  const allByKey = new Map();
  for (const c of all || []) {
    const key = stripMarkdown(c.name || '').toLowerCase();
    if (key) allByKey.set(key, c);
  }
  for (const raw of characterNames || []) {
    const key = stripMarkdown(raw || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const c = allByKey.get(key);
    if (c) out.push(c);
  }
  for (const c of all || []) {
    const key = stripMarkdown(c.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

async function extractEntries({ beat, characters }) {
  const characterLines = characters.length
    ? characters
        .map((c) => `- ${stripMarkdown(c.name || '')}`)
        .filter((s) => s.trim() !== '-')
        .join('\n')
    : '(no named characters known yet)';
  const userText = [
    `# Beat #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    '',
    'Beat description:',
    stripMarkdown(beat.desc || '') || '(none)',
    '',
    'Beat body:',
    stripMarkdown(beat.body || '') || '(none)',
    '',
    'Known character names (use these exactly when they match a speaker):',
    characterLines,
    '',
    'Use the populate_dialog tool to return every line of spoken dialog in story order.',
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
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
