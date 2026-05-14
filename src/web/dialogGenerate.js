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
    'Return the dialogue you wrote for this beat as an ordered list. ' +
    'Each entry is one continuous line spoken by one source. Preserve story order.',
  input_schema: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        description:
          'Ordered list of dialogue entries spoken in this beat, in story order.',
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
    required: ['entries'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a screenwriter writing the dialogue for a single beat of a feature film.',
  'Return your result via the populate_dialog tool, in story order.',
  '',
  'Your job is to write the lines that make this beat land on screen.',
  'The beat description and body are GUIDANCE, not a transcript. Write what the characters would',
  'plausibly say to convey or surface what the beat is about — capture the gist of the beat, not',
  'its exact wording.',
  '',
  'Voice & character:',
  '- Each speaker gets a bio block below. Use it. Match speech patterns, education level, attitude,',
  '  and worldview. If a character has memes / catchphrases, weave them in where they\'d plausibly',
  '  come up — never shoehorn.',
  '- If the beat body already quotes a specific line verbatim, preserve that line exactly and write',
  '  the surrounding dialogue around it.',
  '',
  'Avoid literalism:',
  '- Do NOT restate the beat description or action lines as dialogue. "Alice walked into the diner"',
  '  is action, not a line for Alice to say.',
  '- Do NOT paraphrase the narrator. Find what the characters would actually say in the scene to',
  '  surface what\'s happening, what they want, and how they feel about it.',
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

function formatCharacterBio(c) {
  const plainName = stripMarkdown(c?.name || '').trim();
  if (!plainName) return '';
  const lines = [`## ${plainName}`];
  const actor = stripMarkdown(c.hollywood_actor || '').trim();
  if (actor) lines.push(`hollywood_actor: ${actor}`);
  const fields = c.fields && typeof c.fields === 'object' ? c.fields : {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = stripMarkdown(typeof raw === 'string' ? raw : '').trim();
    if (!value) continue;
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
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
  const characterBlock = characters.length
    ? characters.map(formatCharacterBio).filter(Boolean).join('\n\n')
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
    '# Characters in this story',
    'Use these bios to inform each speaker\'s voice. Use a character\'s exact name when they speak.',
    '',
    characterBlock,
    '',
    'Write the dialogue for this beat using the populate_dialog tool. Capture the gist of the beat',
    'in the characters\' voices — don\'t be literal, don\'t restate action lines as dialogue.',
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
