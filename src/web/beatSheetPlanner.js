// Beat scene-image planner — two-phase.
//
// Phase 1 (holistic): one Anthropic call reads the FULL beat and proposes a
// custom list of standalone SCENE / BACKGROUND / ENVIRONMENT plate images — as
// many as the text needs, no target count. Each plate carries a justification
// and a verbatim quote copied from the beat body.
//
// Phase 2 (per-plate critique): one Anthropic call per plate examines it in
// isolation and returns a verdict — keep / edit / divide / cull — to refine the
// list before it is shown for review.
//
// Plates are mostly-empty location plates (no characters), reusable later as
// storyboard backdrops. Each final entry is { name, prompt, justification, quote };
// only { name, prompt } is ever rendered — justification/quote are review aids.
//
// Two test seams let each phase be exercised without a real API call.

import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import {
  STORYBOARD_MODEL,
  buildBeatContextBlock,
} from './storyboardGenerate.js';

export const MAX_SCENE_IMAGE_COUNT = 20;
// Per-plate critique calls run in parallel, bounded to avoid hammering the API.
export const PHASE2_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Phase 1 — holistic plan
// ---------------------------------------------------------------------------

export const SCENE_PLATE_PLAN_TOOL = {
  name: 'plan_scene_plates',
  description:
    'Plan a custom set of standalone SCENE / BACKGROUND / ENVIRONMENT plate images for one screenplay beat. ' +
    'These are universal location & set plates (generally NO characters) usable later as storyboard backdrops. ' +
    'Return as many plates as the beat text genuinely needs — no fixed count.',
  input_schema: {
    type: 'object',
    properties: {
      plates: {
        type: 'array',
        description: 'The planned plates, in a sensible order (establishing wides first, then set details).',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short gallery label, e.g. "Rain-slick alley — wide".' },
            prompt: {
              type: 'string',
              description:
                'Full standalone image-generation prompt for this background/scene plate: concrete location, time of day, ' +
                'lighting, palette, mood, lens/framing. Encode the spatial layout and the exact sub-location the beat calls for ' +
                '(e.g. "the rear bench of a minivan, the front seats soft in the foreground") and pick a vantage that reveals it. ' +
                'State occupancy explicitly — unoccupied, empty seats by default so the model adds no stray figure; only if the ' +
                'beat truly cannot read without a person, place that figure exactly where the beat puts them. Generally NO ' +
                'characters — an empty environment. ~2–3 sentences. ' +
                'Purely visual: do NOT include any justification or quote text here; this string is sent verbatim to the image model.',
            },
            justification: {
              type: 'string',
              description: 'One sentence: why this plate is appropriate for the beat. Reviewer-facing only — never rendered.',
            },
            quote: {
              type: 'string',
              description: 'A short VERBATIM snippet copied exactly from the beat body that this plate depicts. Reviewer-facing only — never rendered.',
            },
          },
          required: ['name', 'prompt', 'justification', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['plates'],
    additionalProperties: false,
  },
};

export const SCENE_PLATE_PLAN_SYSTEM_PROMPT = [
  'You are a production designer and location scout planning the SET and BACKGROUND plates for one screenplay beat. Return your plan via the plan_scene_plates tool.',
  '',
  '# Goal',
  '- Read the FULL beat, then produce a custom list of standalone scene / background / establishing plates that capture every distinct location, key set detail, and atmosphere the beat calls for.',
  '- Decide the number of plates from the text itself — a short beat needs few, a long or location-rich beat needs more. There is NO target count.',
  '- These are UNIVERSAL BACKDROPS, reused later as storyboard references — so prefer EMPTY or lightly-dressed environments with NO characters in frame.',
  '- Vary the scale: wide establishing shots, mid set views, and tight set-detail inserts (props, textures, signage).',
  '',
  '# For every plate',
  '- prompt: a concrete, standalone, purely-visual image prompt (location, time of day, lighting, palette, mood, lens/framing). Sent verbatim to the image model.',
  '- justification: one sentence on why this plate serves the beat. Reviewer-facing only — never rendered.',
  '- quote: a short VERBATIM snippet copied exactly from the beat body that this plate depicts. Reviewer-facing only — never rendered.',
  '',
  '# How to read the beat',
  '- Beat bodies are screenplay-format (Fountain-flavored): sluglines (INT./EXT. LOCATION — TIME) give location, time of day, and lighting; mini-slugs (BACK SEAT, AT THE WINDOW) name the sub-location a moment happens in; action lines give set dressing and atmosphere.',
  '- Use the supplied reference-image descriptions and the director\'s notes to lock the look (palette, era, mood). Stay consistent with them.',
  '',
  '# Spatial geography & occupancy',
  '- Build each plate around the SUB-LOCATION the beat actually calls for, not the generic room. Read sluglines, mini-slugs, and action lines for where people and props sit, and frame that. If the beat lives in the back seat of a minivan, show the rear bench (third-row seats, the door beside it) from a vantage that reveals it — do not default to the front seats.',
  '- Encode the layout concretely: foreground / midground / background, near / far, left / right, and the specific set features the beat names.',
  '- State OCCUPANCY explicitly. These are empty backdrops, so say the seats / room are unoccupied — image models love to fill a car with a driver, and an unstated minivan interior gets one in the front. When the beat truly cannot read without a figure, place that figure in the exact spot the beat specifies (the rear bench, NOT the front) and note where it is NOT.',
  '',
  '# Constraints',
  '- No characters in the plates unless the beat truly cannot be represented without a figure — these are environments, not staged shots.',
  '- Never put a proper character name in a prompt; image models cannot resolve made-up names.',
  '- Do NOT put justification or quote text into the prompt field.',
].join('\n');

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

export function buildScenePlatePlanUserText({
  beat,
  characters = [],
  referenceInputs = [],
  direction = '',
  directorNotes = [],
  previousPlates = [],
} = {}) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const lines = [
    'Plan the scene/background plates for the beat below. Decide how many from the text — there is no target count.',
    '',
    ctx,
  ];
  if (Array.isArray(previousPlates) && previousPlates.length) {
    lines.push(
      '',
      '# Revision request',
      'You previously proposed the plates below for this beat. The user reviewed them and asked for changes — their feedback is in the "Director\'s commentary" above. Re-plan the FULL set to act on that feedback: keep what works, change or drop what doesn\'t, and add anything missing. Do not simply repeat the old list.',
      '',
      'Previously proposed plates:',
      ...previousPlates.map(
        (p, i) => `${i + 1}. ${String(p?.name || '').trim() || '(unnamed)'} — ${String(p?.prompt || '').trim()}`,
      ),
    );
  }
  const refBlock = formatReferenceInputs(referenceInputs);
  if (refBlock) {
    lines.push('', '# Reference images provided (their stored descriptions — design around these):', refBlock);
  }
  lines.push(
    '',
    'Use the plan_scene_plates tool. For each plate give a purely-visual prompt, a one-sentence justification, and a verbatim quote copied from the beat body.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 2 — per-plate critique
// ---------------------------------------------------------------------------

export const SCENE_PLATE_CRITIQUE_TOOL = {
  name: 'critique_scene_plate',
  description:
    'Critique ONE planned scene/background plate for a screenplay beat in detail and decide what to do with it: ' +
    'keep it as-is, edit it (refine/add detail), divide it into two plates, or cull it (drop it).',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['keep', 'edit', 'divide', 'cull'],
        description: 'keep = good as-is; edit = return an improved prompt; divide = return two plates; cull = drop it.',
      },
      prompt: { type: 'string', description: 'For verdict "edit": the improved, purely-visual prompt.' },
      name: { type: 'string', description: 'For verdict "edit": an optional improved gallery label.' },
      justification: { type: 'string', description: 'For verdict "edit": an optional updated justification.' },
      shots: {
        type: 'array',
        description: 'For verdict "divide": exactly two fully-formed plates.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prompt: { type: 'string' },
            justification: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['name', 'prompt', 'justification', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict'],
    additionalProperties: false,
  },
};

export const SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT = [
  'You are a meticulous storyboard supervisor reviewing ONE proposed scene/background plate for a screenplay beat. Return your decision via the critique_scene_plate tool.',
  '',
  'Examine the single plate in detail against the beat and choose exactly one verdict:',
  '- keep: the plate is already a strong, distinct, purely-visual environment plate. Return it untouched.',
  '- edit: worth keeping but the prompt is vague, generic, or missing concrete visual detail. Return an improved, purely-visual prompt.',
  '- divide: the plate is really two distinct plates (two locations, or a wide AND a detail insert). Return exactly two fully-formed plates.',
  '- cull: redundant with the beat\'s needs, off-topic, requires characters to read, or otherwise should not be generated. Drop it.',
  '',
  'SPATIAL FIDELITY — check this first: compare the prompt against the beat (and the plate\'s quote). If the beat pins a spatial placement or sub-location (e.g. "in the back seat", "by the window") and the prompt drops it or contradicts it, choose "edit" and restore the exact geography. If the prompt would let the image model add or misplace an occupant — a driver in an empty minivan, a figure in the front when the beat says the back — choose "edit" to fix the placement or to state the seats are empty.',
  '',
  'Rules: prompts stay purely visual (no characters unless unavoidable, no proper names, no caption/quote text). Prefer keep/edit over divide; only divide when genuinely two shots. Only cull when the plate adds no value.',
].join('\n');

export function buildScenePlateCritiqueUserText({ beat, characters = [], direction = '', directorNotes = [], plate } = {}) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  return [
    'Critique this single proposed plate for the beat below.',
    '',
    '# The plate',
    `- name: ${plate?.name || ''}`,
    `- prompt: ${plate?.prompt || ''}`,
    `- justification: ${plate?.justification || ''}`,
    `- quote: ${plate?.quote || ''}`,
    '',
    ctx,
    '',
    'Use the critique_scene_plate tool with exactly one verdict.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Normalize + helpers
// ---------------------------------------------------------------------------

// Drop entries missing name/prompt, trim, carry justification/quote, clamp to max.
export function normalizeScenePlanImages(rawImages, { max = MAX_SCENE_IMAGE_COUNT } = {}) {
  if (!Array.isArray(rawImages)) return [];
  const out = [];
  for (const it of rawImages) {
    const name = typeof it?.name === 'string' ? it.name.trim() : '';
    const prompt = typeof it?.prompt === 'string' ? it.prompt.trim() : '';
    if (!name || !prompt) continue;
    const justification = typeof it?.justification === 'string' ? it.justification.trim() : '';
    const quote = typeof it?.quote === 'string' ? it.quote.trim() : '';
    out.push({ name, prompt, justification, quote });
    if (out.length >= max) break;
  }
  return out;
}

function normalizeWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Best-effort: warn (never reject) if a plate's quote is not a whitespace-
// normalized substring of the beat body. Quotes are reviewer aids only.
function warnNonVerbatimQuotes(images, beat) {
  const body = normalizeWs(beat?.body);
  if (!body) return;
  for (const im of images) {
    const q = normalizeWs(im.quote);
    if (q && !body.includes(q)) {
      logger.warn(`beat plate planner: quote not verbatim in beat body: "${(im.quote || '').slice(0, 60)}"`);
    }
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runNext = async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// Apply a single critique verdict to a plate, returning 0, 1, or 2 plates.
function applyVerdict(plate, verdict) {
  const v = verdict || { verdict: 'keep' };
  switch (v.verdict) {
    case 'cull':
      return [];
    case 'edit':
      return [{
        name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : plate.name,
        prompt: typeof v.prompt === 'string' && v.prompt.trim() ? v.prompt.trim() : plate.prompt,
        justification: typeof v.justification === 'string' && v.justification.trim() ? v.justification.trim() : plate.justification,
        quote: plate.quote,
      }];
    case 'divide':
      if (Array.isArray(v.shots) && v.shots.length) {
        const split = v.shots
          .map((s) => ({
            name: typeof s?.name === 'string' ? s.name.trim() : '',
            prompt: typeof s?.prompt === 'string' ? s.prompt.trim() : '',
            justification: typeof s?.justification === 'string' ? s.justification.trim() : '',
            quote: typeof s?.quote === 'string' && s.quote.trim() ? s.quote.trim() : plate.quote,
          }))
          .filter((s) => s.name && s.prompt);
        return split.length ? split : [plate];
      }
      return [plate];
    case 'keep':
    default:
      return [plate];
  }
}

// ---------------------------------------------------------------------------
// Anthropic calls + test seams
// ---------------------------------------------------------------------------

let phase1Override = null;
let phase2Override = null;
// Phase-1 seam: receives the phase-1 args, returns a raw plate array.
export function _setScenePlatePlannerForTests(fn) { phase1Override = fn; }
// Phase-2 seam: receives (plate, ctx), returns a verdict object.
export function _setScenePlateCritiqueForTests(fn) { phase2Override = fn; }

async function callPhase1Anthropic(args) {
  const userText = buildScenePlatePlanUserText(args);
  const client = getAnthropic();
  const resp = await client.messages
    .stream({
      model: STORYBOARD_MODEL,
      max_tokens: 8000,
      system: SCENE_PLATE_PLAN_SYSTEM_PROMPT,
      tools: [SCENE_PLATE_PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'plan_scene_plates' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
    .finalMessage();
  if (resp.stop_reason === 'max_tokens') {
    logger.warn(`beat plate planner (phase 1): hit max_tokens cap (model=${STORYBOARD_MODEL}); response may be truncated`);
  }
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'plan_scene_plates');
  if (!toolUse) {
    logger.warn(`beat plate planner (phase 1): model did not call the tool (stop_reason=${resp.stop_reason})`);
    return [];
  }
  return Array.isArray(toolUse.input?.plates) ? toolUse.input.plates : [];
}

async function callPhase2Anthropic({ beat, characters, direction, directorNotes, plate }) {
  const userText = buildScenePlateCritiqueUserText({ beat, characters, direction, directorNotes, plate });
  const client = getAnthropic();
  const resp = await client.messages
    .stream({
      model: STORYBOARD_MODEL,
      max_tokens: 2000,
      system: SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT,
      tools: [SCENE_PLATE_CRITIQUE_TOOL],
      tool_choice: { type: 'tool', name: 'critique_scene_plate' },
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    })
    .finalMessage();
  const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'critique_scene_plate');
  if (!toolUse) {
    logger.warn(`beat plate critique (phase 2): model did not call the tool (stop_reason=${resp.stop_reason}); keeping plate`);
    return { verdict: 'keep' };
  }
  return toolUse.input || { verdict: 'keep' };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Plan the plate list for a beat in two phases. Returns
// { images: [{ name, prompt, justification, quote }, ...] }.
// onProgress(evt) receives { phase, step, frame?, total?, message } events.
export async function planBeatSceneImages({
  beat,
  characters = [],
  referenceInputs = [],
  direction = '',
  directorNotes = [],
  previousPlates = [],
  onProgress = null,
} = {}) {
  const emit = (e) => { try { onProgress?.(e); } catch { /* progress is best-effort */ } };

  // Phase 1 — holistic plan.
  emit({ phase: 'planning', step: 'plan_start', message: 'Planning scene plates…' });
  const phase1Args = { beat, characters, referenceInputs, direction, directorNotes, previousPlates };
  let rawPlates;
  if (phase1Override) {
    const r = await phase1Override(phase1Args);
    rawPlates = Array.isArray(r) ? r : (r?.plates ?? r?.images ?? []);
  } else {
    rawPlates = await callPhase1Anthropic(phase1Args);
  }
  const planned = normalizeScenePlanImages(rawPlates, { max: MAX_SCENE_IMAGE_COUNT });
  emit({ phase: 'planning', step: 'plan_done', total: planned.length, message: `Planned ${planned.length} plate${planned.length === 1 ? '' : 's'}; critiquing…` });
  if (!planned.length) return { images: [] };

  // Phase 2 — per-plate critique.
  emit({ phase: 'critiquing', step: 'critique_start', total: planned.length, message: `Critiquing ${planned.length} plate${planned.length === 1 ? '' : 's'}…` });
  let done = 0;
  const verdicts = await mapWithConcurrency(planned, PHASE2_CONCURRENCY, async (plate) => {
    let verdict;
    try {
      verdict = phase2Override
        ? await phase2Override(plate, { beat, characters, direction, directorNotes })
        : await callPhase2Anthropic({ beat, characters, direction, directorNotes, plate });
    } catch (e) {
      logger.warn(`beat plate critique failed; keeping plate: ${e.message}`);
      verdict = { verdict: 'keep' };
    }
    done += 1;
    emit({ phase: 'critiquing', step: 'critique_done', frame: done, total: planned.length, message: `Critiqued ${done}/${planned.length}…` });
    return verdict;
  });

  const expanded = [];
  for (let i = 0; i < planned.length; i += 1) {
    expanded.push(...applyVerdict(planned[i], verdicts[i]));
  }
  const images = normalizeScenePlanImages(expanded, { max: MAX_SCENE_IMAGE_COUNT });
  warnNonVerbatimQuotes(images, beat);
  emit({ phase: 'critiquing', step: 'critique_complete', total: images.length, message: `${images.length} plate${images.length === 1 ? '' : 's'} ready for review.` });
  return { images };
}
