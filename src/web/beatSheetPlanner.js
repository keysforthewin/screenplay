// Beat scene-image planner.
//
// Given one beat's contents + the descriptions of the user-picked reference
// images + the project's director's notes, asks the top-tier Anthropic model to
// plan a CUSTOM list of standalone SCENE / BACKGROUND / ENVIRONMENT plate images
// for that beat (no fixed template — unlike the character sheet). These are
// mostly-empty location plates (the set at varied angles / times / lighting),
// reusable later as storyboard backdrops. Each entry is `{ name, prompt }`.
//
// Mirrors the storyboard `planScene` pattern: a single forced-tool Anthropic
// stream → tool_use payload, with a test seam so the runner can be exercised
// without a real API call.

import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import {
  STORYBOARD_MODEL,
  buildBeatContextBlock,
} from './storyboardGenerate.js';

export const MIN_SCENE_IMAGE_COUNT = 3;
export const DEFAULT_SCENE_IMAGE_COUNT = 8;
export const MAX_SCENE_IMAGE_COUNT = 20;

export function clampSceneImageCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_SCENE_IMAGE_COUNT;
  return Math.min(MAX_SCENE_IMAGE_COUNT, Math.max(MIN_SCENE_IMAGE_COUNT, Math.round(v)));
}

export const SCENE_IMAGE_PLAN_TOOL = {
  name: 'plan_scene_images',
  description:
    'Plan a set of standalone SCENE / BACKGROUND / ENVIRONMENT reference images for one screenplay beat. ' +
    'These are universal location & set plates (generally NO characters) usable later as storyboard backdrops. ' +
    'Return one entry per image.',
  input_schema: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        description: 'The planned scene/background images, in a sensible order (establishing wides first, then set details).',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Short gallery label, e.g. "Rain-slick alley — wide" or "Server room — low angle".',
            },
            prompt: {
              type: 'string',
              description:
                'Full standalone image-generation prompt for this background/scene plate: concrete location, time of day, ' +
                'lighting, palette, mood, lens/framing. Establishing plates and set-detail inserts. Generally NO characters — ' +
                'these are empty environments. ~2–3 sentences.',
            },
          },
          required: ['name', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['images'],
    additionalProperties: false,
  },
};

export const SCENE_IMAGE_PLAN_SYSTEM_PROMPT = [
  'You are a production designer and location scout planning the SET and BACKGROUND plates for one screenplay beat. Return your plan via the plan_scene_images tool.',
  '',
  '# Goal',
  '- Produce a custom list of standalone scene / background / establishing images that capture every distinct location, key set detail, and atmosphere this beat needs.',
  '- These are UNIVERSAL BACKDROPS, reused later as storyboard references — so prefer EMPTY or lightly-dressed environments with NO characters in frame.',
  '- Vary the scale: wide establishing shots, mid set views, and tight set-detail inserts (props, textures, signage).',
  '',
  '# How to read the beat',
  '- Beat bodies are screenplay-format (Fountain-flavored): sluglines (INT./EXT. LOCATION — TIME) give location, time of day, and lighting; action lines give set dressing and atmosphere.',
  '- Use the supplied reference-image descriptions and the director\'s notes to lock the look (palette, era, mood). Stay consistent with them.',
  '',
  '# Constraints',
  '- No characters in the plates unless the beat truly cannot be represented without a figure — these are environments, not staged shots.',
  '- Never put a proper character name in a prompt; image models cannot resolve made-up names.',
  '- Aim for approximately the requested number of images; a few more or fewer is fine if the beat clearly needs it.',
].join('\n');

// Build the reference-descriptions block from loadImageInput-shaped entries.
function formatReferenceInputs(referenceInputs) {
  const items = (referenceInputs || [])
    .map((r) => {
      const name = String(r?.name || '').trim();
      const desc = String(r?.description || '').trim();
      if (!name && !desc) return null;
      return `- ${name || 'image'}: ${desc || '(no description on file)'}`;
    })
    .filter(Boolean);
  if (!items.length) return null;
  return items.join('\n');
}

export function buildSceneImagePlanUserText({
  beat,
  characters = [],
  referenceInputs = [],
  direction = '',
  directorNotes = [],
  targetCount,
}) {
  const count = clampSceneImageCount(targetCount);
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const lines = [
    `Plan approximately ${count} scene/background plate images for the beat below.`,
    '',
    ctx,
  ];
  const refBlock = formatReferenceInputs(referenceInputs);
  if (refBlock) {
    lines.push('', '# Reference images provided (their stored descriptions — design around these):', refBlock);
  }
  lines.push(
    '',
    `Use the plan_scene_images tool. Aim for about ${count} images: establishing wides, set views, and detail inserts, mostly empty of characters.`,
  );
  return lines.join('\n');
}

// Drop entries missing name/prompt, trim, and clamp to `max`.
export function normalizeScenePlanImages(rawImages, { max = MAX_SCENE_IMAGE_COUNT } = {}) {
  if (!Array.isArray(rawImages)) return [];
  const out = [];
  for (const it of rawImages) {
    const name = typeof it?.name === 'string' ? it.name.trim() : '';
    const prompt = typeof it?.prompt === 'string' ? it.prompt.trim() : '';
    if (!name || !prompt) continue;
    out.push({ name, prompt });
    if (out.length >= max) break;
  }
  return out;
}

// Test seam — override the Anthropic call. Override receives the same args as
// planBeatSceneImages and should return `{ images: [{name, prompt}, ...] }`
// (raw; normalization still runs).
let scenePlannerOverride = null;
export function _setSceneImagePlannerForTests(fn) {
  scenePlannerOverride = fn;
}

async function callAnthropicPlanner({ beat, characters, referenceInputs, direction, directorNotes, targetCount }) {
  const userText = buildSceneImagePlanUserText({ beat, characters, referenceInputs, direction, directorNotes, targetCount });
  const client = getAnthropic();
  // Stream then collect finalMessage() — matches storyboard planScene (the
  // non-streaming create() is rejected when max_tokens exceeds the model's
  // non-streaming cap).
  const resp = await client.messages
    .stream({
      model: STORYBOARD_MODEL,
      max_tokens: 8000,
      system: SCENE_IMAGE_PLAN_SYSTEM_PROMPT,
      tools: [SCENE_IMAGE_PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'plan_scene_images' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
    .finalMessage();
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(`beat scene-image planner: hit max_tokens cap (model=${STORYBOARD_MODEL}); response may be truncated`);
  }
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'plan_scene_images');
  if (!toolUse) {
    logger.warn(`beat scene-image planner: model did not call the tool (stop_reason=${resp.stop_reason})`);
    return [];
  }
  return Array.isArray(toolUse.input?.images) ? toolUse.input.images : [];
}

// Plan the scene-image list for a beat. Returns { images: [{name, prompt}, ...] }.
export async function planBeatSceneImages({
  beat,
  characters = [],
  referenceInputs = [],
  direction = '',
  directorNotes = [],
  targetCount,
}) {
  const want = clampSceneImageCount(targetCount);
  let rawImages;
  if (scenePlannerOverride) {
    const r = await scenePlannerOverride({ beat, characters, referenceInputs, direction, directorNotes, targetCount: want });
    rawImages = Array.isArray(r) ? r : (r?.images ?? []);
  } else {
    rawImages = await callAnthropicPlanner({ beat, characters, referenceInputs, direction, directorNotes, targetCount: want });
  }
  return { images: normalizeScenePlanImages(rawImages, { max: MAX_SCENE_IMAGE_COUNT }) };
}
