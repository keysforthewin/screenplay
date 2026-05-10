// Storyboard auto-generation pipeline.
//
// Triggered from POST /api/storyboards/generate. Returns immediately with a
// job id; the work runs in the background and broadcasts progress to the
// "storyboards:<beatId>" room as each storyboard is persisted.
//
// Pipeline:
//   1. Anthropic call: break the beat body / desc / characters into a
//      prioritized list of N storyboard segments. Each segment specifies a
//      visual prompt, the characters in the shot, and a brief end-frame
//      variation cue.
//   2. For each segment, in parallel (bounded concurrency):
//      - Collect input reference images: each character's character_sheet_image
//        (or main image), plus the beat's main image (set/scene context).
//      - Call Nano Banana once for the start frame, once for the end frame.
//      - Persist a storyboard row via the gateway, then broadcast a ping.
//
// Errors in a single segment are swallowed (logged) so other segments still
// land — the model can re-run "generate" and just fill in missing frames.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { readImageBuffer, uploadGeneratedImage } from '../mongo/images.js';
import { stripMarkdown } from '../util/markdown.js';
import { generateImage } from '../gemini/client.js';
import {
  createStoryboardViaGateway,
  deleteAllStoryboardsForBeatViaGateway,
  setStoryboardImageViaGateway,
} from './gateway.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';

const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_REFERENCE_IMAGES = 4; // cap input images per Nano Banana call
const SEGMENT_CONCURRENCY = 2;
const DEFAULT_TARGET_COUNT = 6;

const PLAN_TOOL = {
  name: 'plan_storyboard',
  description:
    'Break the beat into a sequence of storyboard frames. Each frame must be one ' +
    'visually distinct moment that, together with the others, forms a coherent ' +
    'shot list for the entire beat. Order them in narrative order.',
  input_schema: {
    type: 'object',
    properties: {
      frames: {
        type: 'array',
        description: 'Ordered list of storyboard frames covering the entire beat.',
        items: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description:
                'One-sentence narrative summary of what happens in this frame.',
            },
            start_prompt: {
              type: 'string',
              description:
                'Concrete visual prompt for the START frame: subject, action, framing, lighting, mood. ~2 sentences.',
            },
            end_prompt: {
              type: 'string',
              description:
                'Concrete visual prompt for the END frame (a small variation showing motion progression from the start). ~2 sentences.',
            },
            characters_in_scene: {
              type: 'array',
              description:
                'Names of characters visible in this frame, exactly as listed in the beat metadata.',
              items: { type: 'string' },
            },
          },
          required: ['description', 'start_prompt', 'end_prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['frames'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a storyboard artist breaking a screenplay beat into shot frames. Return your plan via the plan_storyboard tool.',
  '',
  'Each frame must be a visually distinct moment with a concrete shot description (camera angle, who is in frame, what they are doing).',
  "Do not invent characters that aren't already in the beat's character list.",
  '',
  'Your prompts will be passed to an image generator together with reference photographs of each named character and the set. So:',
  '- Describe action, framing, and composition. Do NOT re-describe a character\'s face, body, or wardrobe — the reference photo carries that.',
  '- Do NOT re-describe the location, lighting palette, or mood — the set reference carries that. You may direct camera lighting (e.g. "lit from below", "harsh key light").',
  '',
  'start_prompt vs end_prompt for the same frame:',
  '- start_prompt = the moment the action begins.',
  '- end_prompt = the SAME shot moments later, showing motion progression. Same camera, same composition, slightly different pose / position. NOT a different angle, NOT a different beat.',
  '',
  'The user message specifies how many frames to plan; honor it.',
].join('\n');

let geminiOverride = null;
export function _setGeminiForTests(fn) {
  geminiOverride = fn;
}

async function callGenerateImage(args) {
  if (geminiOverride) return geminiOverride(args);
  return generateImage(args);
}

// In-memory job tracker. Sufficient for single-process runtime; status survives
// only as long as the process. The SPA polls /api/storyboards/generate/:job_id.
const jobs = new Map();

function makeJobId() {
  return new ObjectId().toString();
}

export function getStoryboardGenerationJob(jobId) {
  return jobs.get(jobId) || null;
}

export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Storyboard work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

export async function startStoryboardGenerationJob({
  beatId,
  targetCount,
  characterSheetOverrides = null,
}) {
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
    planned: 0,
    completed: 0,
    failed: 0,
  };
  jobs.set(jobId, job);
  // Fire and forget; errors are recorded on the job. Holding the per-beat lock
  // for the duration prevents concurrent generates and edit calls from racing
  // the delete-then-recreate window.
  withBeatLock(beat._id, () =>
    runStoryboardGenerationJob({ job, beat, targetCount, characterSheetOverrides }),
  ).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    logger.error(`storyboard gen job ${jobId} crashed: ${e.message}`);
  });
  return jobId;
}

async function runStoryboardGenerationJob({ job, beat, targetCount, characterSheetOverrides }) {
  // Plan first. If the planner returns nothing (model failure, rate limit,
  // empty body) we preserve the user's existing storyboards rather than
  // wiping them for no result.
  job.status = 'planning';
  const characterDocs = await findCharactersInBeat(beat);
  const planned = await planFrames({
    beat,
    characters: characterDocs,
    targetCount: targetCount || DEFAULT_TARGET_COUNT,
  });
  job.planned = planned.length;
  if (!planned.length) {
    job.status = 'done';
    job.finished_at = new Date();
    logger.warn(
      `storyboard gen job ${job.job_id} produced no frames; existing items preserved`,
    );
    return;
  }
  // Now that we know we have a plan, clear the existing storyboards so the
  // SPA shows an empty list while new items stream in.
  await deleteAllStoryboardsForBeatViaGateway({ beatId: beat._id });
  job.status = 'rendering';
  // Pre-load each character's reference image once so we don't re-read GridFS
  // for every frame. Map keys are stripped lowercase names.
  const charImages = await loadCharacterReferenceImages(characterDocs, characterSheetOverrides);
  const beatSetImage = await loadBeatSetImage(beat);
  await runWithConcurrency(planned, SEGMENT_CONCURRENCY, async (frame, index) => {
    try {
      await renderFrame({
        beat,
        frame,
        order: index + 1,
        charImages,
        beatSetImage,
      });
      job.completed += 1;
    } catch (e) {
      job.failed += 1;
      logger.warn(
        `storyboard gen frame ${index + 1}/${planned.length} failed: ${e.message}`,
      );
    }
  });
  job.status = job.failed === 0 ? 'done' : 'partial';
  job.finished_at = new Date();
  logger.info(
    `storyboard gen job ${job.job_id} done planned=${job.planned} ok=${job.completed} fail=${job.failed}`,
  );
}

// Resolve every character named in a beat's `characters` list to its current
// Mongo doc. Exported so the SPA's pre-generation sheet picker hits the same
// resolution path that the renderer uses — guaranteeing the dropdown reflects
// what the renderer will actually pick up.
export async function findCharactersInBeat(beat) {
  const out = [];
  for (const raw of beat?.characters || []) {
    const stripped = stripMarkdown(raw || '').trim();
    if (!stripped) continue;
    try {
      const c = await getCharacter(stripped);
      if (c) out.push(c);
    } catch (e) {
      logger.warn(`storyboard gen: character lookup "${stripped}" failed: ${e.message}`);
    }
  }
  return out;
}

function defaultSheetIdFor(c) {
  if (Array.isArray(c.character_sheet_image_ids) && c.character_sheet_image_ids.length) {
    return c.character_sheet_image_ids[0];
  }
  return c.character_sheet_image_id || null;
}

async function loadCharacterReferenceImages(characterDocs, overrides) {
  const overrideMap = overrides && typeof overrides === 'object' ? overrides : {};
  const map = new Map();
  for (const c of characterDocs) {
    const cid = c._id?.toString?.();
    const overrideId = cid ? overrideMap[cid] : null;
    const sheetId = overrideId || defaultSheetIdFor(c);
    const id =
      sheetId ||
      c.main_image_id ||
      (Array.isArray(c.images) && c.images[0]?._id) ||
      null;
    if (!id) continue;
    const ref = await loadImageInput(id);
    if (!ref) continue;
    const key = stripMarkdown(c.name || '').toLowerCase();
    map.set(key, {
      ...ref,
      characterName: stripMarkdown(c.name || ''),
      characterSheetImageId: sheetId || null,
    });
  }
  return map;
}

async function loadBeatSetImage(beat) {
  const id = beat.main_image_id || (beat.images || [])[0]?._id || null;
  if (!id) return null;
  return loadImageInput(id);
}

async function loadImageInput(imageId) {
  try {
    const result = await readImageBuffer(imageId);
    if (!result) return null;
    const { buffer, file } = result;
    const ct = file.contentType || file.metadata?.contentType;
    if (!ANTHROPIC_OK.has(ct)) return null;
    return { buffer, contentType: ct, _id: file._id };
  } catch (e) {
    logger.warn(`storyboard gen: read image ${imageId} failed: ${e.message}`);
    return null;
  }
}

async function planFrames({ beat, characters, targetCount }) {
  const characterLines = characters.length
    ? characters
        .map((c) => {
          const name = stripMarkdown(c.name || '');
          const role = c.fields?.role || c.fields?.description || '';
          return `- ${name}${role ? ` — ${stripMarkdown(role)}` : ''}`;
        })
        .join('\n')
    : '(no named characters in this beat)';
  const userText = [
    `# Beat #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    '',
    'Beat description:',
    stripMarkdown(beat.desc || '') || '(none)',
    '',
    'Beat body:',
    stripMarkdown(beat.body || '') || '(none)',
    '',
    'Characters in this beat:',
    characterLines,
    '',
    `Plan ${targetCount} storyboard frames covering the whole beat in narrative order. ` +
      'Each frame should be visually distinct from the previous one (different moment, action, or composition). ' +
      'Use the plan_storyboard tool.',
  ].join('\n');

  const client = getAnthropic();
  const resp = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'plan_storyboard' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'plan_storyboard',
  );
  if (!toolUse) {
    logger.warn('storyboard gen: model did not call plan_storyboard');
    return [];
  }
  const frames = Array.isArray(toolUse.input?.frames) ? toolUse.input.frames : [];
  return frames.filter(
    (f) =>
      f &&
      typeof f.start_prompt === 'string' &&
      typeof f.end_prompt === 'string',
  );
}

async function renderFrame({ beat, frame, order, charImages, beatSetImage }) {
  const sceneNames = (frame.characters_in_scene || [])
    .map((n) => stripMarkdown(n || '').toLowerCase())
    .filter(Boolean);
  const charRefs = sceneNames
    .map((n) => charImages.get(n))
    .filter(Boolean)
    .slice(0, MAX_REFERENCE_IMAGES - (beatSetImage ? 1 : 0));
  // seedFragments populates the y-doc text_prompt fragment before the
  // gateway's broadcast, so the SPA's CollabField renders the prompt
  // immediately rather than appearing empty until reload.
  const textPrompt = buildTextPrompt(frame);
  const sb = await createStoryboardViaGateway({
    beatId: beat._id,
    textPrompt,
    order,
    seedFragments: { text_prompt: textPrompt },
  });

  const inputImages = [
    ...charRefs.map((r) => ({ buffer: r.buffer, contentType: r.contentType })),
    ...(beatSetImage ? [{ buffer: beatSetImage.buffer, contentType: beatSetImage.contentType }] : []),
  ];

  const startContext = buildVisualPrompt({
    framePrompt: frame.start_prompt,
    description: frame.description,
    charRefs,
    beatSetImage,
    role: 'start',
  });
  const endContext = buildVisualPrompt({
    framePrompt: frame.end_prompt,
    description: frame.description,
    charRefs,
    beatSetImage,
    role: 'end',
  });

  const [startResult, endResult] = await Promise.allSettled([
    callGenerateImage({
      prompt: startContext,
      aspectRatio: '16:9',
      inputImages,
    }),
    callGenerateImage({
      prompt: endContext,
      aspectRatio: '16:9',
      inputImages,
    }),
  ]);

  if (startResult.status === 'fulfilled') {
    await persistFrameImage({
      storyboardId: sb._id,
      role: 'start_frame',
      result: startResult.value,
      beatId: beat._id,
      orderHint: `start-${order}`,
    });
  } else {
    logger.warn(`storyboard gen: start frame ${order} failed: ${startResult.reason?.message || startResult.reason}`);
  }
  if (endResult.status === 'fulfilled') {
    await persistFrameImage({
      storyboardId: sb._id,
      role: 'end_frame',
      result: endResult.value,
      beatId: beat._id,
      orderHint: `end-${order}`,
    });
  } else {
    logger.warn(`storyboard gen: end frame ${order} failed: ${endResult.reason?.message || endResult.reason}`);
  }

  // If the segment names a single primary character, attach that character's
  // sheet image as the storyboard's character_sheet so the SPA can show it.
  if (charRefs.length === 1 && charRefs[0].characterSheetImageId) {
    try {
      await setStoryboardImageViaGateway({
        storyboardId: sb._id,
        role: 'character_sheet',
        imageId: charRefs[0].characterSheetImageId,
      });
    } catch (e) {
      logger.warn(`storyboard gen: attach char sheet failed: ${e.message}`);
    }
  }
}

function buildTextPrompt(frame) {
  const lines = [];
  if (frame.description) lines.push(stripMarkdown(frame.description));
  if (frame.start_prompt) {
    lines.push('');
    lines.push(`**Start frame:** ${stripMarkdown(frame.start_prompt)}`);
  }
  if (frame.end_prompt) {
    lines.push('');
    lines.push(`**End frame:** ${stripMarkdown(frame.end_prompt)}`);
  }
  if (frame.characters_in_scene?.length) {
    lines.push('');
    lines.push(
      `_Characters: ${frame.characters_in_scene.map((n) => stripMarkdown(n)).join(', ')}_`,
    );
  }
  return lines.join('\n');
}

function buildVisualPrompt({ framePrompt, description, charRefs, beatSetImage, role }) {
  const lines = [];
  lines.push(framePrompt);
  if (description) {
    lines.push('');
    lines.push(`Context: ${stripMarkdown(description)}`);
  }
  const refLines = [];
  for (const ref of charRefs) {
    refLines.push(
      `- The image of ${ref.characterName} above is the canonical reference for that character.`,
    );
  }
  if (beatSetImage) {
    refLines.push(
      '- The set image above is the canonical reference for the location, lighting, and mood.',
    );
  }
  if (refLines.length) {
    lines.push('');
    lines.push('Reference materials:');
    lines.push(...refLines);
  }
  lines.push('');
  lines.push(
    role === 'start'
      ? 'Render the beginning moment of this frame as a cinematic still.'
      : 'Render the end moment of this frame as a cinematic still — show motion progression beyond the start.',
  );
  return lines.join('\n');
}

async function persistFrameImage({ storyboardId, role, result, beatId, orderHint }) {
  const file = await uploadGeneratedImage({
    buffer: result.buffer,
    contentType: result.contentType,
    prompt: null,
    generatedBy: 'gemini-2.5-flash-image',
    ownerType: 'beat',
    ownerId: beatId,
    filename: `storyboard-${storyboardId}-${orderHint}.png`,
  });
  await setStoryboardImageViaGateway({
    storyboardId,
    role,
    imageId: file._id,
  });
}

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
  return results;
}
