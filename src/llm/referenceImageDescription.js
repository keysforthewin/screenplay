// Tuned vision describer for reference images that will be re-fed to an
// image generator. Unlike the terse `analyzeLibraryImage` caption (good for
// library search), this prompt extracts the structural / geometric / palette
// / lighting detail an image generator needs to recreate the image
// faithfully when given the description as a verbal anchor alongside the
// reference image itself.
//
// Returns {name, description}. Failures collapse to {name:'', description:''}
// so upload pipelines never fail because of vision.
//
// Used by:
//   - libraryVisionWorker.js for owned (beat / character / storyboard)
//     reference images.
//   - storyboardGenerate.js to caption the freshly-rendered start frame so
//     the end frame call has a verbal anchor for what to preserve.

import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';

// Default model for vision describe — Haiku is cheap and fast, used by the
// library vision worker (batches of dozens of images). Callers that need
// higher fidelity (e.g. the storyboard pipeline) pass an explicit `model`.
const DEFAULT_VISION_MODEL = config.anthropic.enhancerModel || 'claude-haiku-4-5-20251001';
const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_RAW = 4 * 1024 * 1024;

export const REFERENCE_KINDS = Object.freeze(['auto', 'character', 'location', 'prop']);

const SHARED_TAIL = [
  '',
  'Output rules:',
  '- Respond with EXACTLY one line of compact JSON: {"name": "<3-6 word noun-phrase title>", "description": "<the description as a single paragraph>"}.',
  '- No markdown, no code fences, no commentary outside the JSON.',
  '- The description must be a single paragraph (no bullet lists in the JSON value).',
  '- Be specific and concrete — vague descriptors ("nice lighting", "modern building") defeat the purpose. Name colors, materials, counts, directions.',
  '- If a trait is not visible, say so explicitly rather than guessing.',
].join('\n');

const SYSTEM_PROMPTS = {
  // Default — covers everything. Use when the kind is unknown or mixed
  // (e.g. a beat scene image that includes both a location and characters).
  auto: [
    'You generate detailed reference descriptions for images that will be fed back to an image generator as visual references. The description must capture enough structure, geometry, palette, and lighting detail that the same image could be re-rendered from the description alone.',
    '',
    'Cover every axis that is visible:',
    '- Subject(s): who or what is depicted, count, position in frame, scale.',
    '- For human / character subjects: hair color (specific shade), hair length, hairstyle; approximate age, height, build; skin tone; eye color and shape; jaw, nose, lips, eyebrows; freckles / moles / scars / distinguishing marks; clothing (garments, colors, fabrics, fit, era, accessories, footwear); posture; expression; mood.',
    '- For locations / sets / architecture: structural geometry (window count, window shape, door placement, roof shape, room dimensions, ceiling height, wall layout); materials (brick course, weathered wood, polished concrete, stained glass, etc); fixture placement (lamps, signs, furniture).',
    '- Color palette: name specific shades ("oxidized copper green", "ochre with rust streaks") rather than generic ("greenish", "warm").',
    '- Lighting: key light direction (e.g. "low-angle warm key from camera-right"), color temperature, hard vs. soft, fill, practicals visible in frame, time of day, weather.',
    '- Camera and framing: lens feel (wide / normal / long), height, angle, depth-of-field cues.',
    '- Atmosphere / mood: dust, fog, smoke, rain, particulate, film-grain look.',
  ].join('\n') + SHARED_TAIL,

  // Used when the caller knows the image is a person/character portrait —
  // omits set/architecture sections to keep the prompt focused.
  character: [
    'You generate detailed character reference descriptions for portrait images that will be fed back to an image generator as visual references. The description must capture enough physical detail that the same person could be re-rendered consistently in many future frames.',
    '',
    'For each character in the frame, capture every one of:',
    '- Hair color (specific shade — e.g. "ash blonde", "jet black with copper highlights", not just "dark").',
    '- Hair length (e.g. "shoulder-length", "cropped close to the scalp", "down to mid-back").',
    '- Hairstyle (e.g. "loose waves with a center part", "high ponytail with curtain bangs", "tight braids gathered into a low bun").',
    '- Approximate age, height, and build.',
    '- Skin tone and complexion notes.',
    '- Eye color and eye shape.',
    '- Facial features: jaw shape, nose, lips, eyebrows, freckles / moles / scars / other distinguishing marks.',
    '- Clothing: garments, colors, fabrics, fit, era / style, accessories, footwear.',
    '- Posture, expression, mood.',
    '',
    'Also note camera framing (close-up, medium, wide), background context if relevant, and lighting on the face (key direction, color temperature, hard / soft).',
  ].join('\n') + SHARED_TAIL,

  // Used when the caller knows the image is a location / set / building.
  location: [
    'You generate detailed location reference descriptions for images of sets, environments, or architecture that will be fed back to an image generator as visual references. The description must capture enough structural and atmospheric detail that the same place could be re-rendered consistently in many future frames.',
    '',
    'Capture every axis that is visible:',
    '- Architectural geometry: window count and shape (e.g. "three lancet arches"), door placement, roof shape and pitch, room dimensions, ceiling height, wall layout, floor plan cues.',
    '- Materials and surfaces: name specifics — "weathered cedar shingles", "oxidized copper flashing", "polished concrete with hairline cracks", "stained-glass with cobalt blue and amber panels".',
    '- Fixtures and dressing: lamps, signs, furniture, props, vegetation; their placement in frame.',
    '- Color palette: name specific shades ("ochre with rust streaks", "muted teal walls"), not generic categories.',
    '- Lighting: key direction, color temperature (warm tungsten / daylight / cool overcast), hard vs. soft, practicals visible in frame, time of day, weather, season cues.',
    '- Atmosphere: dust, fog, smoke, rain, particulate, film-grain look.',
    '- Camera and framing: lens feel, height, angle, depth-of-field.',
  ].join('\n') + SHARED_TAIL,

  prop: [
    'You generate detailed prop reference descriptions for images of objects, costumes, or props that will be fed back to an image generator as visual references. The description must capture enough physical detail that the same object could be re-rendered consistently in many future frames.',
    '',
    'Capture every axis that is visible:',
    '- Object identity, count, scale, orientation, position in frame.',
    '- Geometry and silhouette: dimensions, proportions, distinctive contours.',
    '- Materials and surface finish: e.g. "brushed brass with patina", "cracked leather over wooden form".',
    '- Color palette: specific shades and finish (matte / glossy / metallic / translucent).',
    '- Wear, damage, ornamentation, inscriptions.',
    '- Lighting falling on the object: direction, color temperature, hard / soft.',
    '- Camera framing: macro / close / medium, angle.',
  ].join('\n') + SHARED_TAIL,
};

const USER_PROMPT =
  'Describe this image as a faithful reference. Return only the JSON object: {"name": ..., "description": ...}.';

function safeParse(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(stripped);
    if (!obj || typeof obj !== 'object') return null;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    const description = typeof obj.description === 'string' ? obj.description.trim() : '';
    return { name, description };
  } catch {
    return null;
  }
}

export async function describeReferenceImage({ buffer, contentType, kind = 'auto', model = null } = {}) {
  if (!config.anthropic?.apiKey) return { name: '', description: '' };
  if (!Buffer.isBuffer(buffer)) return { name: '', description: '' };
  if (!ANTHROPIC_OK.has(contentType)) {
    logger.warn(`describeReferenceImage: unsupported type ${contentType}`);
    return { name: '', description: '' };
  }
  if (buffer.length > MAX_RAW) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1);
    logger.warn(
      `describeReferenceImage: image too large (${mb} MB), skipping vision describe`,
    );
    return { name: '', description: '' };
  }
  const sys = SYSTEM_PROMPTS[kind] || SYSTEM_PROMPTS.auto;

  const t0 = Date.now();
  try {
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: model || DEFAULT_VISION_MODEL,
      max_tokens: 1500,
      system: sys,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: USER_PROMPT },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: contentType,
                data: buffer.toString('base64'),
              },
            },
          ],
        },
      ],
    });
    const text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const parsed = safeParse(text);
    if (!parsed) {
      logger.warn(`describeReferenceImage: parse failed (${Date.now() - t0}ms)`);
      return { name: '', description: '' };
    }
    logger.info(
      `describeReferenceImage[${kind}]: name=${parsed.name.length}c desc=${parsed.description.length}c ${Date.now() - t0}ms`,
    );
    return parsed;
  } catch (e) {
    logger.warn(`describeReferenceImage: ${e.message} (${Date.now() - t0}ms)`);
    return { name: '', description: '' };
  }
}
