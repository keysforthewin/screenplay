// Prompts tab auto-generation: beat → a handful of self-contained Seedance-style
// video prompts, each covering up to 30 s (multi-shot allowed) and each
// carrying the reference images it names as @Image1..@ImageN.
//
// Triggered from POST /api/video-prompts/generate. Returns immediately with a
// job id; the work runs in the background under the per-beat lock and
// broadcasts to the "video_prompts:<beatId>" room as each row is persisted.
//
// Pipeline (single LLM call, text only):
//   1. Build the reference image CATALOG for the beat: the ARTWORK of the
//      beat's characters and sets (done artworks only — uploaded portraits,
//      character sheets and gallery images are deliberately excluded; the
//      Artwork section is the curated look), numbered 1..N with description.
//   2. One Anthropic call with the whole beat in context (directorial voice,
//      beat text, scene bible, characters, sets, director's notes, dialogue
//      for turn order only, the catalog). The model answers via the
//      write_video_prompts tool: ordered prompts, each with a title, a target
//      duration, the catalog indexes it references (in @Image order) and the
//      prompt text.
//   3. Post-process: resolve indexes → catalog entries (drop unknown /
//      duplicate, cap at 9), clamp durations to 4..30, rewrite dangling
//      @ImageK handles (K beyond the picked count) and record warnings.
//   4. Wipe the beat's existing prompts, then create one row per prompt via
//      the gateway with the y-doc fragments seeded so the SPA shows the text
//      immediately.
//
// If the model returns no prompts the existing rows are preserved (the dialog
// generator's precedent).

import { ObjectId } from 'mongodb';
import { modelFor } from '../llm/modelSlots.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { findImageFile, imageFileToMeta } from '../mongo/images.js';
import { renderSceneBibleBlock } from '../mongo/sceneBible.js';
import {
  MAX_REFERENCE_IMAGES,
  MIN_PROMPT_DURATION,
  MAX_PROMPT_DURATION,
} from '../mongo/videoPrompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { getAnthropic } from '../anthropic/client.js';
import {
  createVideoPromptViaGateway,
  deleteAllVideoPromptsForBeatViaGateway,
} from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import {
  findCharactersInBeat,
  findSetsInBeat,
  loadDirectorNotesForPlanner,
  loadDialogsForPlanner,
  loadDirectorialVoice,
  buildBeatContextBlock,
} from './storyboardGenerate.js';
import { clipBlock } from './setDescriptionGenerate.js';
import {
  ANTI_SLOP_RULES,
  NO_TEXT_RULES,
  CAMERA_MOTION_RULES,
  PERFORMANCE_RULES,
  FRAGILITY_RULES,
} from './storyboardConstraints.js';

// Catalog cap: enough for two or three characters' artwork and a set or two,
// small enough that the context stays a list rather than a wall.
export const MAX_CATALOG_ENTRIES = 40;
const MAX_PROMPTS = 12;
const BEAT_TEXT_CAP = 12000;

// ─── Reference image catalog ────────────────────────────────────────────────

async function imageMeta(id) {
  try {
    const file = await findImageFile(id);
    if (!file) return null;
    const meta = imageFileToMeta(file);
    return {
      name: String(meta.name || '').trim(),
      description: String(meta.description || '').trim(),
    };
  } catch (e) {
    logger.warn(`video prompt gen: image meta ${id} failed: ${e.message}`);
    return null;
  }
}

// The artwork a host (character or set doc) carries — its "Artwork" section,
// done artworks with a result image only. Uploaded portraits, character
// sheets and gallery images are NOT offered: the Artwork section is the
// curated look, and the user asked for prompts to draw from it alone. Each
// entry carries a human label ("Sarah — artwork: Rain plate") and the best
// description we have (GridFS metadata description, then the artwork's own
// description or prompt).
function hostImageSlots(host) {
  const slots = [];
  for (const a of host?.artworks || []) {
    if (a?.status !== 'done' || !a.result_image_id) continue;
    slots.push({
      id: String(a.result_image_id),
      kind: `artwork${a.name ? `: ${String(a.name).trim()}` : ''}`,
      caption: (String(a.description || '').trim() || String(a.prompt || '').trim()),
    });
  }
  return slots;
}

// Build the numbered reference catalog for a beat — artwork only. Returns
// [{ index (1-based), image_id (string), owner_type, owner_name, label,
//    description }] deduped by image id and capped at MAX_CATALOG_ENTRIES.
// Exported for the /video-prompts/candidates route (the SPA's picker) and
// for the PATCH route's id → entry resolution.
export async function buildReferenceCatalog(projectId, beat) {
  const [characters, sets] = await Promise.all([
    findCharactersInBeat(projectId, beat),
    findSetsInBeat(projectId, beat),
  ]);
  const hosts = [
    ...characters.map((c) => ({ doc: c, ownerType: 'character' })),
    ...sets.map((s) => ({ doc: s, ownerType: 'set' })),
  ];
  const out = [];
  const seen = new Set();
  for (const { doc, ownerType } of hosts) {
    const ownerName = stripMarkdown(doc?.name || '').trim() || (ownerType === 'set' ? 'Set' : 'Character');
    for (const slot of hostImageSlots(doc)) {
      if (seen.has(slot.id)) continue;
      if (out.length >= MAX_CATALOG_ENTRIES) break;
      seen.add(slot.id);
      const meta = await imageMeta(slot.id);
      const description = meta?.description || slot.caption || '';
      const nameBit = meta?.name ? ` (${meta.name})` : '';
      out.push({
        index: out.length + 1,
        image_id: slot.id,
        owner_type: ownerType,
        owner_name: ownerName,
        label: `${ownerName} — ${slot.kind}${nameBit}`,
        description,
      });
    }
    if (out.length >= MAX_CATALOG_ENTRIES) break;
  }
  return out;
}

export function formatReferenceCatalog(catalog) {
  if (!catalog?.length) return '(no artwork available for this beat\'s characters and sets — write the prompts without @Image handles)';
  return catalog
    .map((e) => {
      const tag = e.owner_type === 'set' ? 'SET' : 'CHARACTER';
      const desc = e.description ? ` — ${clipBlock(e.description, 240)}` : '';
      return `${e.index}. [${tag} ${e.owner_name}] ${e.label}${desc}`;
    })
    .join('\n');
}

// ─── Tool + prompts ─────────────────────────────────────────────────────────

// Strict tool schema: no numeric minimum/maximum (the Messages API rejects
// them inside strict schemas — see SCENE_PLAN_TOOL); the bounds are enforced
// in post-processing instead.
export const WRITE_PROMPTS_TOOL = {
  name: 'write_video_prompts',
  strict: true,
  description:
    'Return the ordered video prompts that cover this beat. Each prompt is one self-contained ' +
    'generation (up to 30 seconds, one to four shots) and names the reference images it uses.',
  input_schema: {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        description: 'Ordered list of prompts, in beat order. Together they cover the whole beat.',
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Short label for this prompt (3–8 words), e.g. "Sarah enters the diner".',
            },
            duration_seconds: {
              type: 'integer',
              description: 'Target clip length in whole seconds, 4 to 30.',
            },
            reference_image_indexes: {
              type: 'array',
              description:
                'Catalog numbers of the reference images this prompt uses, at most 9, in the order they ' +
                'are handed to the model: the first becomes @Image1, the second @Image2, and so on. ' +
                'Only list images the prompt text actually names.',
              items: { type: 'integer' },
            },
            prompt: {
              type: 'string',
              description:
                'The video prompt. Names its subjects by @ImageN handle in the first sentence, then ' +
                'describes the shots in order with bracketed camera instructions.',
            },
          },
          required: ['title', 'duration_seconds', 'reference_image_indexes', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['prompts'],
    additionalProperties: false,
  },
};

export const SYSTEM_PROMPT = [
  'You are a film director writing generation prompts for a reference-to-video model (Seedance 2.5 class) that',
  'accepts up to 9 reference images and renders up to 30 seconds per prompt, with several shots inside one',
  'prompt. You are given one beat of a screenplay with its full context. Return your prompts via the',
  'write_video_prompts tool, in beat order.',
  '',
  'Coverage:',
  '- The prompts together cover the WHOLE beat continuously, in story order, with no gaps and no overlap.',
  '- Each prompt is ONE self-contained generation: it is rendered on its own, so it must restate everything it',
  '  needs (who is on screen, where, the light, the time of day). Never refer to an earlier prompt.',
  '- Each prompt is at most 30 seconds. Choose the length the action needs — a quick moment may be 6 seconds,',
  '  a long exchange may take the full 30. Write as many prompts as the beat needs and no more.',
  '',
  'Shots inside a prompt:',
  '- One to four shots per prompt. Start each shot with a bracketed camera instruction naming the shot size',
  '  and, if the camera moves, the move: [Wide shot, static], [Medium two-shot, slow push in],',
  '  [Close-up on the woman, handheld], [Tracking shot following him down the corridor].',
  '- Supported moves: static, push in, pull out, truck left/right, pan, tilt, pedestal, zoom, tracking,',
  '  handheld shake. One primary move per shot, with its motivation.',
  '- Give the shots a rough time budget so the whole prompt lands on its duration (e.g. "for the first 8',
  '  seconds", "over the last 5 seconds").',
  '',
  'Reference images — the catalog:',
  '- The catalog lists the artwork available, numbered. Pick the ones this prompt needs (one clear image of',
  '  each person on screen; one of the location) and list their catalog numbers in reference_image_indexes.',
  '  The FIRST number becomes @Image1, the second @Image2, and so on.',
  '- The FIRST SENTENCE of the prompt binds every handle: "@Image1 is Sarah, @Image2 is Tom, @Image3 is the',
  '  diner interior." After that, refer to people and places by their handle (or by handle plus a short',
  '  physical description) — never by their character name alone, because the model does not know names.',
  '- Only reference handles you listed, and list only handles the prompt names. At most 9 per prompt.',
  '- When several artworks show the same person or place, pick the one whose description best matches the',
  '  framing and state this prompt needs (full body for wides, face for close-ups, the right time of day).',
  '',
  'What the prompt describes:',
  '- Lighting key, palette, time of day, weather, the materials and surfaces in the location.',
  '- Blocking — where each person is, where they move, and where they end up.',
  '- Performance — speech turns, facial changes, listener behaviour, per the performance rules below.',
  '- The endpoint of each shot: the last frame must differ from the first.',
  '',
  'Dialogue:',
  '- The dialogue in the context is for TURN ORDER and DELIVERY only. NEVER write the words, quoted lines,',
  '  voice-over, or sound effects into a prompt: the real performance is recorded by actors and lip-synced in',
  '  post. Describe the mouth, breath, and rhythm of who speaks when, not what they say.',
  '',
  PERFORMANCE_RULES,
  '',
  CAMERA_MOTION_RULES,
  '',
  NO_TEXT_RULES,
  '',
  ANTI_SLOP_RULES,
  '',
  FRAGILITY_RULES,
  '',
  'Format: plain prose, 120–350 words per prompt, no markdown, no headings, no bullet lists. Bracketed camera',
  'instructions are the only structural marks. Titles are short labels, not sentences.',
].join('\n');

export function buildUserText({ beat, characters, sets, directorNotes, dialogs, directorialVoice, catalog, direction }) {
  const clippedBeat = {
    ...beat,
    body: clipBlock(beat.body || '', BEAT_TEXT_CAP),
  };
  const ctx = buildBeatContextBlock({
    beat: clippedBeat,
    characters,
    sets,
    direction,
    directorNotes,
    dialogs,
    directorialVoice,
  });
  const lines = [ctx];
  const bible = renderSceneBibleBlock(beat.scene_bible);
  if (bible) {
    lines.push('', 'Scene bible (the look every prompt of this beat inherits):', bible);
  }
  lines.push(
    '',
    '# Reference image catalog',
    'Artwork of this beat\'s characters and sets. Pick by number. The first number you list becomes @Image1, the second @Image2, and so on.',
    formatReferenceCatalog(catalog),
    '',
    'Write the prompts that cover this whole beat with the write_video_prompts tool. Each prompt is a',
    'self-contained generation of at most 30 seconds with one to four bracketed shots, binds its @Image',
    'handles in its first sentence, and never contains the dialogue words.',
  );
  return lines.join('\n');
}

// ─── Post-processing ────────────────────────────────────────────────────────

const HANDLE_RE = /@Image(\d+)/g;

function clampDuration(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 10;
  return Math.min(MAX_PROMPT_DURATION, Math.max(MIN_PROMPT_DURATION, n));
}

// Resolve one raw tool entry against the catalog. Returns null when the entry
// has no usable prompt text. Pushes human-readable warnings for every repair.
export function normalizePromptEntry(raw, catalog, index, warnings) {
  const prompt = typeof raw?.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) return null;
  const title = (typeof raw?.title === 'string' ? raw.title.trim() : '') || `Prompt ${index + 1}`;
  const byIndex = new Map((catalog || []).map((e) => [e.index, e]));
  const picks = [];
  const seen = new Set();
  const rawIdx = Array.isArray(raw?.reference_image_indexes) ? raw.reference_image_indexes : [];
  for (const v of rawIdx) {
    const n = Number(v);
    const entry = byIndex.get(n);
    if (!entry) {
      warnings.push(`Prompt ${index + 1}: dropped unknown reference image #${v}.`);
      continue;
    }
    if (seen.has(entry.image_id)) continue;
    seen.add(entry.image_id);
    if (picks.length >= MAX_REFERENCE_IMAGES) {
      warnings.push(`Prompt ${index + 1}: more than ${MAX_REFERENCE_IMAGES} reference images; extras dropped.`);
      break;
    }
    picks.push(entry);
  }
  // Dangling handles: @ImageK with K past the pick count can't be honoured
  // by the model (it only sees the uploaded images), so neutralise them.
  let text = prompt;
  let dangling = 0;
  text = text.replace(HANDLE_RE, (m, k) => {
    const n = Number(k);
    if (n >= 1 && n <= picks.length) return m;
    dangling += 1;
    return 'the subject';
  });
  if (dangling) {
    warnings.push(
      `Prompt ${index + 1}: ${dangling} @Image handle${dangling === 1 ? '' : 's'} pointed past the ${picks.length} attached reference${picks.length === 1 ? '' : 's'} and were rewritten.`,
    );
  }
  const rawDur = Number(raw?.duration_seconds);
  const duration = clampDuration(rawDur);
  if (Number.isFinite(rawDur) && rawDur !== duration) {
    warnings.push(`Prompt ${index + 1}: duration ${rawDur}s clamped to ${duration}s.`);
  }
  return {
    title,
    prompt: text,
    duration_seconds: duration,
    reference_images: picks.map((e) => ({
      image_id: e.image_id,
      owner_type: e.owner_type,
      owner_name: e.owner_name,
      label: e.label,
    })),
  };
}

export function normalizePromptEntries(rawList, catalog) {
  const warnings = [];
  const out = [];
  const list = Array.isArray(rawList) ? rawList.slice(0, MAX_PROMPTS) : [];
  for (let i = 0; i < list.length; i++) {
    const entry = normalizePromptEntry(list[i], catalog, i, warnings);
    if (entry) out.push(entry);
  }
  return { prompts: out, warnings };
}

// ─── LLM call ───────────────────────────────────────────────────────────────

let writerOverride = null;
export function _setVideoPromptWriterForTests(fn) {
  writerOverride = fn;
}

async function writePrompts({ userText }) {
  if (writerOverride) return writerOverride({ userText });
  const client = getAnthropic();
  const model = modelFor('storyboard');
  const resp = await client.messages
    .stream({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: [WRITE_PROMPTS_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
    .finalMessage();
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(`video prompt gen: hit max_tokens cap (model=${model}); response may be truncated`);
  }
  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'write_video_prompts',
  );
  if (!toolUse) {
    logger.warn(`video prompt gen: model did not call write_video_prompts (stop_reason=${resp.stop_reason})`);
    return [];
  }
  return Array.isArray(toolUse.input?.prompts) ? toolUse.input.prompts : [];
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();

export function getVideoPromptGenerationJob(jobId) {
  return jobs.get(jobId) || null;
}

export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

export async function startVideoPromptGenerationJob({ projectId, beatId, direction = '' }) {
  const beat = await getBeat(projectId, beatId);
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  if (isBeatLocked(beat._id)) throw new BeatBusyError(beat._id.toString());
  const jobId = new ObjectId().toString();
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    status: 'queued',
    started_at: new Date(),
    finished_at: null,
    error: null,
    generated: 0,
    created: 0,
    warnings: [],
  };
  jobs.set(jobId, job);
  withBeatLock(beat._id, () => runJob({ job, beat, projectId, direction })).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    logger.error(`video prompt gen job ${jobId} crashed: ${e.message}`);
  });
  return jobId;
}

async function runJob({ job, beat, projectId, direction }) {
  job.status = 'generating';
  const [characters, sets, directorNotes, dialogs, directorialVoice, catalog] = await Promise.all([
    findCharactersInBeat(projectId, beat),
    findSetsInBeat(projectId, beat),
    loadDirectorNotesForPlanner(projectId),
    loadDialogsForPlanner(projectId, beat._id),
    loadDirectorialVoice(projectId),
    buildReferenceCatalog(projectId, beat),
  ]);
  const userText = buildUserText({
    beat,
    characters,
    sets,
    directorNotes,
    dialogs,
    directorialVoice,
    catalog,
    direction: typeof direction === 'string' ? direction : '',
  });
  const rawList = await writePrompts({ userText });
  const { prompts, warnings } = normalizePromptEntries(rawList, catalog);
  job.generated = prompts.length;
  job.warnings = warnings;
  if (!prompts.length) {
    job.status = 'done';
    job.finished_at = new Date();
    logger.warn(`video prompt gen job ${job.job_id} produced no prompts; existing rows preserved`);
    return;
  }
  job.status = 'writing';
  await deleteAllVideoPromptsForBeatViaGateway({ projectId, beatId: beat._id });
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    try {
      await createVideoPromptViaGateway({
        projectId,
        beatId: beat._id,
        title: p.title,
        prompt: p.prompt,
        durationSeconds: p.duration_seconds,
        referenceImages: p.reference_images,
        order: i + 1,
        seedFragments: { title: p.title, prompt: p.prompt },
      });
      job.created += 1;
    } catch (e) {
      logger.warn(`video prompt gen entry ${i + 1}/${prompts.length} failed: ${e.message}`);
      job.warnings.push(`Prompt ${i + 1} could not be saved: ${e.message}`);
    }
  }
  job.status = 'done';
  job.finished_at = new Date();
  logger.info(
    `video prompt gen job ${job.job_id} done generated=${job.generated} created=${job.created} warnings=${job.warnings.length}`,
  );
}
