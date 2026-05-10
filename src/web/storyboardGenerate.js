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
import {
  getStoryboard,
  listStoryboards,
  SHOT_TYPES,
  clampDuration,
  MAX_CHARS_PER_SHOT,
  MAX_TRANSITION_LEN,
} from '../mongo/storyboards.js';
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
const DEFAULT_TARGET_COUNT = 11;

const PLAN_TOOL = {
  name: 'plan_storyboard',
  description:
    'Break the beat into a sequence of cinematic storyboard frames. Each frame is one ' +
    'visually distinct moment with a chosen shot type and on-screen duration. ' +
    'Order them in narrative order. Pad with embellishment shots (establishing, insert, ' +
    'reaction, atmospheric cutaway) to give the sequence cinematic rhythm.',
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
            shot_type: {
              type: 'string',
              enum: [...SHOT_TYPES],
              description:
                'Framing/coverage class. Drives the duration cap. ' +
                'establishing/cinematic_wide/insert ≤ 15s, medium ≤ 10s, ' +
                'close_up/reaction/two_shot/over_the_shoulder ≤ 5s.',
            },
            duration_seconds: {
              type: 'integer',
              minimum: 1,
              maximum: 15,
              description:
                'On-screen hold time. Must respect the cap implied by shot_type.',
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
            transition_in: {
              type: 'string',
              description:
                'Brief one-line continuity note describing how this shot picks up from the previous one. Empty for the first frame. ' +
                'Examples: "Picks up the door swing from #3"; "Match cut from the spinning coin to the diner sign".',
            },
            characters_in_scene: {
              type: 'array',
              description:
                'Names of characters visible in this frame, exactly as listed in the beat metadata. ' +
                'AT MOST 2 names. Embellishment shots (atmospheric cutaways, establishing wides, inserts of objects) may be empty.',
              items: { type: 'string' },
            },
          },
          required: [
            'description',
            'shot_type',
            'duration_seconds',
            'start_prompt',
            'end_prompt',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['frames'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = [
  'You are a Hollywood storyboard artist breaking a screenplay beat into a cinematic shot list. Return your plan via the plan_storyboard tool.',
  '',
  'Each frame is one visually distinct moment with a concrete shot description (camera angle, who is in frame, what they are doing).',
  "Do not invent characters that aren't already in the beat's character list.",
  '',
  'Your prompts will be passed to an image generator together with reference photographs of each named character and the set. So:',
  "- Describe action, framing, composition, and camera lighting only. Do NOT re-describe a character's face, body, or wardrobe — the reference photo carries that.",
  '- Do NOT re-describe the location, lighting palette, or mood — the set reference carries that. You may direct camera lighting (e.g. "lit from below", "harsh key light").',
  '',
  'start_prompt vs end_prompt for the same frame:',
  '- start_prompt = the moment the action begins.',
  '- end_prompt = the SAME shot moments later, showing motion progression. Same camera, same composition, slightly different pose / position. NOT a different angle, NOT a different beat.',
  '',
  '# Coverage and rhythm',
  '- Plan for cinematic rhythm, not just narrative coverage. Pad the shot list with embellishment shots:',
  '  - Open with an establishing wide of the location.',
  '  - Insert close-ups for objects, hands, eyes, props that carry meaning.',
  '  - Reaction close-ups after key beats.',
  '  - Atmospheric cutaways (rain on glass, ticking clock, empty hallway) when the beat needs breathing room.',
  '  - Use over_the_shoulder for two-person dialogue.',
  '- Vary framing across the sequence — wides, mediums, close-ups in rotation, not three close-ups in a row.',
  '',
  '# Adjacency / continuity',
  '- Adjacent frames must hand off cleanly. The end_prompt of frame N should leave the eye on something the start_prompt of frame N+1 picks up — a shared subject, a matching motion vector, or a deliberate match cut.',
  '- Use transition_in on each frame after the first to state the continuity link in one sentence.',
  '',
  '# Hard constraints',
  '- Maximum 2 named characters in characters_in_scene per frame. If a beat has 4 people in a room, alternate coverage (two_shot of A+B, then two_shot of C+D, then a wide).',
  '- shot_type drives duration_seconds:',
  '  - establishing / cinematic_wide / insert → 1..15s',
  '  - medium → 1..10s',
  '  - close_up / reaction → 1..5s',
  '  - two_shot / over_the_shoulder → 1..5s',
  '- The user message specifies how many frames to plan; honor it.',
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
    `Plan ${targetCount} cinematic storyboard frames covering the whole beat in narrative order, ` +
      'with embellishment shots (establishing/insert/reaction/atmospheric) interleaved among the narrative beats. ' +
      'Each frame must be visually distinct from the previous one (different moment, action, or composition) ' +
      'AND continuous with it (shared element, motion vector, or match cut). ' +
      'Pick a shot_type and duration_seconds for every frame. Use the plan_storyboard tool.',
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
  return frames.flatMap(cleanPlannedFrame);
}

// Validate, clamp, and normalize a single planner-emitted frame. Returns
// either [cleanedFrame] or [] (drop the frame). Co-located with planFrames so
// the warn logs read in line with where the bad model output came from.
function cleanPlannedFrame(f) {
  if (!f || typeof f.start_prompt !== 'string' || typeof f.end_prompt !== 'string') {
    return [];
  }
  const shotType = SHOT_TYPES.includes(f.shot_type) ? f.shot_type : null;
  if (!shotType && f.shot_type != null) {
    logger.warn(`storyboard plan: dropping invalid shot_type "${f.shot_type}"`);
  }
  const clampedDur = clampDuration(f.duration_seconds, shotType);
  if (
    f.duration_seconds != null &&
    Number.isFinite(Number(f.duration_seconds)) &&
    Number(f.duration_seconds) !== clampedDur
  ) {
    logger.warn(
      `storyboard plan: duration ${f.duration_seconds}s clamped to ${clampedDur}s for shot_type=${shotType}`,
    );
  }
  const rawChars = Array.isArray(f.characters_in_scene)
    ? f.characters_in_scene
        .map((n) => stripMarkdown(String(n ?? '')).trim())
        .filter(Boolean)
    : [];
  if (rawChars.length > MAX_CHARS_PER_SHOT) {
    logger.warn(
      `storyboard plan: trimming characters_in_scene from ${rawChars.length} to ${MAX_CHARS_PER_SHOT}`,
    );
  }
  const transition =
    typeof f.transition_in === 'string' && f.transition_in.trim()
      ? f.transition_in.trim().slice(0, MAX_TRANSITION_LEN)
      : null;
  return [
    {
      ...f,
      shot_type: shotType,
      duration_seconds: clampedDur,
      transition_in: transition,
      characters_in_scene: rawChars.slice(0, MAX_CHARS_PER_SHOT),
    },
  ];
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
    durationSeconds: frame.duration_seconds ?? null,
    shotType: frame.shot_type ?? null,
    transitionIn: frame.transition_in ?? null,
    charactersInScene: frame.characters_in_scene ?? [],
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
    shotType: frame.shot_type ?? null,
  });
  const endContext = buildVisualPrompt({
    framePrompt: frame.end_prompt,
    description: frame.description,
    charRefs,
    beatSetImage,
    role: 'end',
    shotType: frame.shot_type ?? null,
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
  const headerParts = [];
  if (frame.shot_type) {
    headerParts.push(`**${frame.shot_type.replace(/_/g, ' ').toUpperCase()}**`);
  }
  if (Number.isFinite(Number(frame.duration_seconds))) {
    headerParts.push(`${frame.duration_seconds}s`);
  }
  if (headerParts.length) lines.push(headerParts.join(' · '));
  if (frame.description) {
    if (lines.length) lines.push('');
    lines.push(stripMarkdown(frame.description));
  }
  if (frame.transition_in) {
    lines.push('');
    lines.push(`_↳ ${stripMarkdown(frame.transition_in)}_`);
  }
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

function buildVisualPrompt({
  framePrompt,
  description,
  charRefs,
  beatSetImage,
  role,
  shotType = null,
  continuityRef = null,
}) {
  const lines = [];
  if (shotType) {
    lines.push(`Shot type: ${shotType.replace(/_/g, ' ').toUpperCase()}.`);
  }
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
  if (continuityRef) {
    refLines.push(`- ${continuityRef.label}`);
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
  if (continuityRef) {
    lines.push(continuityRef.directive);
  }
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
  return file;
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

const FRAME_ROLES = new Set(['start_frame', 'end_frame']);

export class FrameRoleError extends Error {
  constructor(role) {
    super(`unsupported frame role: ${role}`);
    this.code = 'BAD_FRAME_ROLE';
    this.status = 400;
  }
}

// Regenerate a single frame (start_frame | end_frame) on an existing storyboard
// row. Reuses the batch pipeline's reference loaders so the inputs match
// exactly: the beat's scene image plus each in-scene character's sheet (or all
// beat characters if the row doesn't pin a single character). The row's
// current `text_prompt` is used verbatim — when the user edits it via the SPA
// they get a regenerated frame that reflects the new prompt.
//
// Synchronous: the SPA awaits the response. Nano banana is fast enough that
// this fits within typical HTTP timeouts; the character-sheet job/poll
// pattern exists for gpt-image-2 (60+s) and isn't needed here.
export async function regenerateStoryboardFrame({ storyboardId, role }) {
  if (!FRAME_ROLES.has(role)) throw new FrameRoleError(role);
  const sb = await getStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beat = await getBeat(sb.beat_id);
  if (!beat) throw new Error(`Beat not found for storyboard ${storyboardId}`);
  if (isBeatLocked(beat._id)) {
    throw new BeatBusyError(beat._id.toString());
  }

  const beatSetImage = await loadBeatSetImage(beat);
  const charRefs = await loadFrameCharacterRefs({ beat, sb, beatSetImage });
  const continuityRef = await loadContinuityReference({ sb, role });

  // Reference image budget: characters first (cap to leave room for set +
  // continuity), set image, then continuity ref last so it always lands in
  // the slot the prompt's "final image above" sentence refers to.
  const continuitySlots = continuityRef ? 1 : 0;
  const setSlots = beatSetImage ? 1 : 0;
  const charsToInclude = charRefs.slice(
    0,
    Math.max(0, MAX_REFERENCE_IMAGES - setSlots - continuitySlots),
  );

  const inputImages = [
    ...charsToInclude.map((r) => ({ buffer: r.buffer, contentType: r.contentType })),
    ...(beatSetImage
      ? [{ buffer: beatSetImage.buffer, contentType: beatSetImage.contentType }]
      : []),
    ...(continuityRef
      ? [{ buffer: continuityRef.buffer, contentType: continuityRef.contentType }]
      : []),
  ];

  const prompt = buildVisualPrompt({
    framePrompt: sb.text_prompt || '',
    description: '',
    charRefs: charsToInclude,
    beatSetImage,
    role: role === 'start_frame' ? 'start' : 'end',
    shotType: sb.shot_type || null,
    continuityRef: continuityRef
      ? { label: continuityRef.label, directive: continuityRef.directive }
      : null,
  });

  const result = await callGenerateImage({
    prompt,
    aspectRatio: '16:9',
    inputImages,
  });

  const file = await persistFrameImage({
    storyboardId: sb._id,
    role,
    result,
    beatId: beat._id,
    orderHint: `${role === 'start_frame' ? 'start' : 'end'}-${sb.order}`,
  });

  return { image_id: file._id.toString() };
}

// Pull a single continuity reference image:
// - end_frame regen: the row's own start_frame_id (so the end matches the start).
// - start_frame regen: the previous row's end_frame_id (so the cut between
//   shots feels continuous).
// Returns { buffer, contentType, label, directive } or null. The caller
// appends this last in inputImages so the prompt's "final image above"
// sentence is unambiguous.
async function loadContinuityReference({ sb, role }) {
  if (role === 'end_frame') {
    if (!sb.start_frame_id) return null;
    const ref = await loadImageInput(sb.start_frame_id);
    if (!ref) return null;
    return {
      ...ref,
      label:
        "The final image above is THIS shot's start frame. Maintain visual continuity with it: same camera, same composition, same lighting; only motion progresses.",
      directive:
        'Match the start frame above frame-for-frame: identical camera angle, framing, and character positioning, with only natural motion progression.',
    };
  }
  if (role === 'start_frame') {
    if (sb.order <= 1) return null;
    const siblings = await listStoryboards({ beatId: sb.beat_id });
    const prev = siblings.find((s) => Number(s.order) === Number(sb.order) - 1);
    if (!prev || !prev.end_frame_id) return null;
    const ref = await loadImageInput(prev.end_frame_id);
    if (!ref) return null;
    return {
      ...ref,
      label:
        "The final image above is the PREVIOUS shot's end frame. Pick up the visual thread from it — shared lighting, matching motion vector, or a deliberate match cut.",
      directive:
        "Maintain continuity with the previous shot's end frame: shared lighting, costume/prop continuity, and a sensible cut point.",
    };
  }
  return null;
}

// Decide which character sheets to pass as references for a single-row regen.
// If the row already pins one character (set during the batch when the planner
// names exactly one character_in_scene), use just that sheet — it's the most
// faithful continuation of how the row was first generated. Otherwise fall
// back to every character on the beat, capped to leave room for the scene
// image within MAX_REFERENCE_IMAGES.
async function loadFrameCharacterRefs({ beat, sb, beatSetImage }) {
  const cap = MAX_REFERENCE_IMAGES - (beatSetImage ? 1 : 0);
  const characterDocs = await findCharactersInBeat(beat);
  if (sb.character_sheet_image_id) {
    // Find which character this sheet belongs to so the prompt can name it
    // ("The image of <name> above is the canonical reference..."). The batch
    // pipeline only pins character_sheet_image_id when exactly one character
    // was in scene, so a clean lookup is expected.
    const sheetIdStr = String(sb.character_sheet_image_id);
    const owner = characterDocs.find((c) => {
      const ids = Array.isArray(c.character_sheet_image_ids)
        ? c.character_sheet_image_ids
        : [];
      const legacy = c.character_sheet_image_id;
      return (
        ids.some((x) => String(x) === sheetIdStr) ||
        (legacy && String(legacy) === sheetIdStr)
      );
    });
    const ref = await loadImageInput(sb.character_sheet_image_id);
    if (ref) {
      return [
        {
          ...ref,
          characterName: owner ? stripMarkdown(owner.name || '') : '',
        },
      ].slice(0, cap);
    }
  }
  const map = await loadCharacterReferenceImages(characterDocs, null);
  return Array.from(map.values()).slice(0, cap);
}
