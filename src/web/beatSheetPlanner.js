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
                'Image-generation prompt for this background/scene plate. TWO FORMS depending on reference_indexes: ' +
                'a plate WITH references renders through an image-EDIT model, so write a MINIMAL EDIT INSTRUCTION — the ' +
                'reference is final and authoritative. Anchor on it ("Edit this photo of the movie theater…"), add ONE blanket ' +
                'keep clause ("keep everything exactly as it is — same framing, same architecture, all existing text, signage, ' +
                'logos, and graphics unchanged"), then the FEWEST changes the beat actually requires — usually exactly one ' +
                '(e.g. "change only: the sky is now a clear night filled with stars"). Never reframe, never alter or add ' +
                'wording, never add new elements, never touch the architecture, never re-describe what the reference already ' +
                'shows. A plate with NO references gets a full standalone scene description: concrete location, time of day, ' +
                'lighting, palette, mood, lens/framing. For refless plates, encode the spatial layout and the exact ' +
                'sub-location the beat calls for (e.g. "the rear bench of a minivan, the front seats soft in the foreground") ' +
                'and pick a vantage that reveals it, and state occupancy explicitly — unoccupied, empty seats by default so ' +
                'the model adds no stray figure; only if the beat truly cannot read without a person, place that figure ' +
                'exactly where the beat puts them. Generally NO characters — an empty environment. Capture only the ' +
                'static environment — no moving or transient subjects (a shooting star, passing car, bursting firework); show ' +
                'the empty scene the motion would happen in front of. Carry NO WORDING either way: text is composited in ' +
                'post-production, so a refless prompt renders signs, marquees, screens and banners as blank unlettered ' +
                'surfaces, and a reffed prompt leaves the reference\'s own lettering untouched. ~2–3 sentences. Purely visual: do NOT include any ' +
                'justification or quote text here; this string is sent verbatim to the image model.',
            },
            justification: {
              type: 'string',
              description: 'One sentence: why this plate is appropriate for the beat. Reviewer-facing only — never rendered.',
            },
            quote: {
              type: 'string',
              description: 'A short VERBATIM snippet copied exactly from the beat body that this plate depicts. Reviewer-facing only — never rendered.',
            },
            requires_reference: {
              type: 'boolean',
              description:
                'true when this plate depicts an ESTABLISHED visual — the set/location itself, a specific recurring building, ' +
                'prop, or vehicle whose look must stay consistent with existing imagery — so it must be rendered with a ' +
                'reference image the user assigns. false for standalone imagery (generic skies, weather, anonymous streets, ' +
                'textures) that a good prompt fully specifies on its own.',
            },
            reference_indexes: {
              type: 'array',
              items: { type: 'integer' },
              description:
                'Which of the numbered reference images (1-based) the image model should receive when rendering THIS plate. ' +
                'Assign only references that depict this plate\'s own subject; omit or leave empty for a plate that should render ' +
                'standalone from its prompt alone. Every assigned reference must have its role stated in the prompt.',
            },
          },
          required: ['name', 'prompt', 'justification', 'quote', 'requires_reference'],
          additionalProperties: false,
        },
      },
    },
    required: ['plates'],
    additionalProperties: false,
  },
};

// Shared static-plate rules — reused by the storyboard image-sheet tuner so its
// proposed plates obey the same clean-background discipline. Keep verbatim.
export const STATIC_PLATE_CONSTRAINTS = [
  '- These are CLEAN PLATES — capture only the static set and environment. Omit anything moving, transient, or mid-action even when the beat describes it: shooting stars, lightning, fireworks, explosions, falling/flying objects, moving vehicles, splashing water, birds in flight, drifting smoke as a subject, etc. Render the empty background as it looks BEFORE or AFTER that element passes through — the video stage adds the motion later. (You may keep the lighting such an event casts, e.g. the glow it throws across a rooftop, but never the moving object itself.)',
  '- No characters in the plates unless the beat truly cannot be represented without a figure — these are environments, not staged shots.',
  '- Never put a proper character name in a prompt; image models cannot resolve made-up names.',
  '- TEXT IS ADDED IN POST-PRODUCTION — a plate carries no wording. Never write words for the image model to letter (no "the marquee bills…", no "the sign reads…", no spelled-out brand names, no captions or watermarks). Write lettered surfaces as empty, positively stated: "a blank unlettered marquee letterboard", "a smooth empty sign panel", "a dark screen". The one exception is a plate rendered as an EDIT of an assigned reference — that reference\'s existing text and signage stay exactly as they are (never repainted blank, never reworded).',
  '- Do NOT put justification or quote text into the prompt field.',
].join('\n');

export const SCENE_PLATE_PLAN_SYSTEM_PROMPT = [
  'You are a production designer and location scout planning the SET and BACKGROUND plates for one screenplay beat. Return your plan via the plan_scene_plates tool.',
  '',
  '# Goal',
  '- Read the FULL beat and name (to yourself) its VISUAL INTENT: the one or two images the beat is actually about. Plan one plate per image in that intent; every other plate must justify its existence against it.',
  '- Plan the FEWEST plates that cover the beat: one plate per distinct visual the beat actually stages. Never pad the list for variety — a beat dominated by a single image (one sky, one room) gets exactly one plate for it, rendered as beautifully as the prompt can make it. Add a wide/detail split ONLY when the beat itself dwells on both.',
  '- The weight of the plate list must mirror the weight of the beat. An element the beat only pans past, lands on, or mentions in passing gets AT MOST one modest plate — never its own wide + detail set, however richly the set description happens to describe it. The set description grounds the LOOK of what you render; it does not add plates — plates come only from what the beat stages.',
  '- Decide the number of plates from the text itself — a short beat needs few (often just 1–2). There is NO target count and no minimum. When unsure whether a plate is needed, leave it out.',
  '- These are UNIVERSAL BACKDROPS, reused later as storyboard references — so prefer EMPTY or lightly-dressed environments with NO characters in frame.',
  '',
  '# For every plate',
  '- prompt: a concrete, purely-visual image prompt. Sent verbatim to the image model together with ONLY the reference images this plate assigns. Its FORM depends on that assignment — a MINIMAL EDIT instruction when references are assigned, a standalone scene description (location, time of day, lighting, palette, mood, lens/framing) when none are. See the reference-images section.',
  '- justification: one sentence on why this plate serves the beat. Reviewer-facing only — never rendered.',
  '- quote: a short VERBATIM snippet copied exactly from the beat body that this plate depicts. Reviewer-facing only — never rendered.',
  '- requires_reference: whether this plate NEEDS a reference image (see below).',
  '- reference_indexes: the numbered reference images to send with THIS plate (see below).',
  '',
  '# Marking requires_reference',
  '- Mark requires_reference: true when the plate depicts an ESTABLISHED visual whose look must match existing imagery — the set/location itself, a recurring building, a specific prop or vehicle the story keeps returning to. The user will assign the matching reference image before rendering; without one, continuity breaks.',
  '- Mark requires_reference: false for standalone imagery a good prompt fully specifies on its own: generic skies and starfields, weather, anonymous streets and rooms, textures, and atmosphere plates.',
  '',
  '# Reference images (assign per plate via reference_indexes)',
  '- The reference images are attached to this message, numbered "Reference image 1..N". LOOK at them — do not rely on their descriptions alone.',
  '- For each plate, assign ONLY the references that depict that plate\'s own subject (the same building, room, or object). A plate whose subject appears in no reference gets an EMPTY assignment and a fully standalone prompt — an unrelated reference would contaminate the render.',
  '- A plate WITH references renders through an image-EDIT model: it receives the reference image(s) and treats the prompt as an editing instruction. The reference is FINAL and authoritative — its framing, composition, architecture, and every piece of text, signage, logo, and graphic on it are already correct and already aligned with the project\'s visual style. The director\'s notes and set description are already baked into it; never restate them as changes. Write the prompt as a MINIMAL EDIT of the reference: (1) anchor on it up front ("Edit this photo of the movie theater…"), (2) ONE blanket keep clause — "keep everything exactly as it is: same framing and composition, same architecture, all existing text, signage, logos, and graphics unchanged" — never an itemized list of what to keep (anything you fail to itemize becomes fair game), (3) then the FEWEST changes the beat actually requires — usually exactly ONE (e.g. "change only: the sky is now a clear night filled with stars"). Every change you list is something the model may repaint, so add nothing for polish, style, or completeness. Never reframe, recrop, or change the vantage; never alter or add wording; never add new objects or imagery; never modify the architecture or layout. If the beat needs a different angle of the subject than the reference shows, that is a refless plate (or no plate), not an edit. Do NOT re-describe what the reference already shows: a competing description makes the model rebuild the subject from your words and discard the reference. If the beat genuinely needs a detail changed, state it as an explicit change; never silently describe a different-looking subject.',
  '- A plate with NO references is the opposite: the image model sees only the prompt, so write a complete standalone scene description.',
  '- Use references for continuity (an established location, prop, or look), never as a mood board.',
  '',
  '# How to read the beat',
  '- Beat bodies are screenplay-format (Fountain-flavored): sluglines (INT./EXT. LOCATION — TIME) give location, time of day, and lighting; mini-slugs (BACK SEAT, AT THE WINDOW) name the sub-location a moment happens in; action lines give set dressing and atmosphere.',
  '- Use the supplied reference-image descriptions and the director\'s notes to lock the look (palette, era, mood). Stay consistent with them.',
  '',
  '# Spatial geography & occupancy (plates WITHOUT references)',
  '- This section applies to REFLESS plates only. A plate with references inherits its geography, framing, and occupancy from the reference image; occupancy enters that prompt only as an explicit change (e.g. "remove the people from the lot").',
  '- Build each plate around the SUB-LOCATION the beat actually calls for, not the generic room. Read sluglines, mini-slugs, and action lines for where people and props sit, and frame that. If the beat lives in the back seat of a minivan, show the rear bench (third-row seats, the door beside it) from a vantage that reveals it — do not default to the front seats.',
  '- Encode the layout concretely: foreground / midground / background, near / far, left / right, and the specific set features the beat names.',
  '- State OCCUPANCY explicitly. These are empty backdrops, so say the seats / room are unoccupied — image models love to fill a car with a driver, and an unstated minivan interior gets one in the front. When the beat truly cannot read without a figure, place that figure in the exact spot the beat specifies (the rear bench, NOT the front) and note where it is NOT.',
  '',
  '# Constraints',
  STATIC_PLATE_CONSTRAINTS,
].join('\n');

// Numbered so the planner can assign them per plate via reference_indexes.
// The numbering here MUST match the labeled image blocks appended by
// buildScenePlatePlanContent — both are 1-based over the same array.
function formatReferenceInputs(referenceInputs) {
  const items = (referenceInputs || []).map((r, i) => {
    const name = String(r?.name || '').trim();
    const desc = String(r?.description || '').trim();
    return `- Reference image ${i + 1} — ${name || 'image'}: ${desc || '(no description on file)'}`;
  });
  if (!items.length) return null;
  return items.join('\n');
}

function referenceLabel(r, i) {
  const name = String(r?.name || '').trim();
  return `Reference image ${i + 1}${name ? ` — ${name}` : ''}:`;
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
    lines.push(
      '',
      '# Reference images provided (numbered; the images themselves are attached below):',
      refBlock,
      '',
      'Assign each plate the reference numbers that depict its own subject via reference_indexes — possibly none.',
    );
  }
  lines.push(
    '',
    'Use the plan_scene_plates tool. For each plate give a purely-visual prompt, a one-sentence justification, and a verbatim quote copied from the beat body.',
  );
  return lines.join('\n');
}

// Multimodal form of the phase-1 user message: the plan text followed by one
// labeled image block per reference input that has bytes. Labels keep the same
// 1-based numbering as the text list (an entry without bytes keeps its number
// but contributes no image, so reference_indexes stay aligned).
export function buildScenePlatePlanContent(args = {}) {
  const blocks = [{ type: 'text', text: buildScenePlatePlanUserText(args) }];
  const refs = Array.isArray(args.referenceInputs) ? args.referenceInputs : [];
  refs.forEach((r, i) => {
    if (!r?.buffer) return;
    blocks.push(
      { type: 'text', text: referenceLabel(r, i) },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: r.contentType || 'image/png',
          data: Buffer.from(r.buffer).toString('base64'),
        },
      },
    );
  });
  return blocks;
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
      requires_reference: {
        type: 'boolean',
        description:
          'For verdict "edit": the corrected requires_reference marking (true = the plate depicts an established visual ' +
          'and must render with a user-assigned reference image). Omit to keep the plate\'s current marking.',
      },
      reference_indexes: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'For verdict "edit": the corrected reference assignment (1-based indexes into the available reference list; ' +
          'empty = render standalone). Omit to keep the plate\'s current assignment.',
      },
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
            requires_reference: { type: 'boolean' },
            reference_indexes: { type: 'array', items: { type: 'integer' } },
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
  '- edit: worth keeping but the prompt needs fixing. For a REFLESS plate that means vague, generic, or missing concrete visual detail — return an improved, purely-visual prompt. For a plate WITH assigned references the pressure runs the OPPOSITE way — see the MINIMAL-EDIT CHECK; a short prompt there is correct, never "vague".',
  '- divide: the plate is really two distinct plates (two locations, or a wide AND a detail insert). Return exactly two fully-formed plates.',
  '- cull: redundant with the beat\'s needs, off-topic, requires characters to read, exists only to depict a moving/transient event, or otherwise should not be generated. Drop it.',
  '',
  'STATIC-PLATE CHECK — check this first: these are clean background plates, not action frames. If the prompt describes a moving or transient subject (a shooting star, lightning bolt, passing vehicle, falling object, explosion, bursting firework), choose "edit" and rewrite it as the clean empty background — keep the location, lighting, and palette, drop the moving element so only the static environment remains. If the plate exists ONLY to depict that moving event and nothing else is left once it is removed, choose "cull".',
  '',
  'INTENT CHECK: weigh the plate against what the beat actually dwells on — the plate list as a whole must mirror the beat\'s emphasis. A beat dominated by one image (one sky, one room) needs exactly one plate of it; an element the beat only pans past, lands on, or mentions in passing earns at most one modest plate. If this plate depicts a secondary or transitional element the beat does not dwell on — an extra angle of it, a detail insert of a location that is only where the camera ends up — choose "cull". A richly-described set does not entitle a richly-covered plate list: plates come from what the beat stages, not from how much description exists. Prefer culling a marginal plate over keeping it.',
  '',
  'SPATIAL FIDELITY (refless plates only — a reffed plate\'s geography and framing come from its reference): compare the prompt against the beat (and the plate\'s quote). If the beat pins a spatial placement or sub-location (e.g. "in the back seat", "by the window") and the prompt drops it or contradicts it, choose "edit" and restore the exact geography. If the prompt would let the image model add or misplace an occupant — a driver in an empty minivan, a figure in the front when the beat says the back — choose "edit" to fix the placement or to state the seats are empty.',
  '',
  'REFERENCE CHECK: the plate carries requires_reference — true means it depicts an ESTABLISHED visual (the set itself, a recurring building/prop) that must be rendered against a user-assigned reference image; false means standalone imagery the prompt fully specifies. If the marking is wrong (a plate of the story\'s specific location marked false, or a generic sky marked true), choose "edit" and return the corrected requires_reference. When available reference images are listed: a reference that does not depict the plate\'s own subject contaminates the render — if any assigned reference is unrelated (a building reference on a pure sky plate), "edit" the reference_indexes; if a reference clearly depicts the plate\'s subject but is not assigned, "edit" to assign it AND rewrite the prompt as an edit instruction. A plate with assigned references whose prompt reads as a fresh SCENE DESCRIPTION instead of an EDIT instruction also needs "edit": a reference-assigned prompt must anchor on the reference ("Edit this photo of…"), carry a blanket keep-everything clause, and list only the changes — re-describing what the reference already shows makes the image model rebuild the subject from the words and discard the reference.',
  '',
  'MINIMAL-EDIT CHECK (plates WITH assigned references only): the reference is final — its framing, architecture, text, signage, logos, and styling are already correct, so the ideal prompt is an anchor, one blanket "keep everything exactly as it is" clause, and the FEWEST changes the beat actually requires (usually exactly one). Short is correct here; never expand a reffed plate\'s prompt with scene detail, style notes, or layout description. Choose "edit" to STRIP the prompt down when it: lists changes the beat does not require, itemizes what to keep instead of one blanket keep clause, reframes/recrops/changes the vantage, restates the project\'s style or the set description as changes, or re-describes the subject. Every listed change is something the image model may repaint — cut everything that is not strictly needed.',
  '',
  'NO-TEXT CHECK: text is added in POST-PRODUCTION, so a plate carries no wording. If a REFLESS prompt hands the image model words to letter — "the marquee bills…", "the sign reads…", a spelled-out brand name, a caption — choose "edit" and rewrite that surface as empty and positively stated ("a blank unlettered marquee letterboard", "a smooth empty sign panel", "a dark screen"), keeping everything else. If the plate exists ONLY to show lettering (a title card, a headline, a screen of copy), "edit" it down to the bare surface the words will be composited over, or "cull" it if nothing else remains. This check does NOT apply to a plate with assigned references: that reference\'s existing text, signage, and logos are final — never "edit" a prompt to blank them out or to reword them.',
  '',
  'Rules: prompts stay purely visual (no characters unless unavoidable, no proper names, no caption/quote text). Prefer keep/edit over divide; only divide when genuinely two shots. Only cull when the plate adds no value.',
].join('\n');

export function buildScenePlateCritiqueUserText({ beat, characters = [], direction = '', directorNotes = [], referenceInputs = [], plate } = {}) {
  const ctx = buildBeatContextBlock({ beat, characters, direction, directorNotes });
  const lines = [
    'Critique this single proposed plate for the beat below.',
    '',
    '# The plate',
    `- name: ${plate?.name || ''}`,
    `- prompt: ${plate?.prompt || ''}`,
    `- justification: ${plate?.justification || ''}`,
    `- quote: ${plate?.quote || ''}`,
    `- requires_reference: ${plate?.requires_reference ? 'true' : 'false'}`,
  ];
  const refBlock = formatReferenceInputs(referenceInputs);
  if (refBlock) {
    const assigned = Array.isArray(plate?.reference_indexes) ? plate.reference_indexes : [];
    lines.push(
      `- assigned references: ${assigned.length ? assigned.join(', ') : '(none — renders standalone)'}`,
      '',
      '# Available reference images (by number; only the assigned ones are sent to the image model with this plate):',
      refBlock,
    );
  }
  lines.push('', ctx, '', 'Use the critique_scene_plate tool with exactly one verdict.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Normalize + helpers
// ---------------------------------------------------------------------------

// Sanitize a plate's reference_indexes: unique positive integers, in order.
function normalizeReferenceIndexes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && !out.includes(n)) out.push(n);
  }
  return out;
}

// Drop entries missing name/prompt, trim, carry justification/quote and the
// per-plate reference assignment, clamp to max.
export function normalizeScenePlanImages(rawImages, { max = MAX_SCENE_IMAGE_COUNT } = {}) {
  if (!Array.isArray(rawImages)) return [];
  const out = [];
  for (const it of rawImages) {
    const name = typeof it?.name === 'string' ? it.name.trim() : '';
    const prompt = typeof it?.prompt === 'string' ? it.prompt.trim() : '';
    if (!name || !prompt) continue;
    const justification = typeof it?.justification === 'string' ? it.justification.trim() : '';
    const quote = typeof it?.quote === 'string' ? it.quote.trim() : '';
    out.push({
      name,
      prompt,
      justification,
      quote,
      reference_indexes: normalizeReferenceIndexes(it?.reference_indexes),
      requires_reference: Boolean(it?.requires_reference),
    });
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
        requires_reference: typeof v.requires_reference === 'boolean' ? v.requires_reference : plate.requires_reference,
        reference_indexes: Array.isArray(v.reference_indexes)
          ? normalizeReferenceIndexes(v.reference_indexes)
          : plate.reference_indexes,
      }];
    case 'divide':
      if (Array.isArray(v.shots) && v.shots.length) {
        const split = v.shots
          .map((s) => ({
            name: typeof s?.name === 'string' ? s.name.trim() : '',
            prompt: typeof s?.prompt === 'string' ? s.prompt.trim() : '',
            justification: typeof s?.justification === 'string' ? s.justification.trim() : '',
            quote: typeof s?.quote === 'string' && s.quote.trim() ? s.quote.trim() : plate.quote,
            requires_reference: typeof s?.requires_reference === 'boolean' ? s.requires_reference : plate.requires_reference,
            reference_indexes: Array.isArray(s?.reference_indexes)
              ? normalizeReferenceIndexes(s.reference_indexes)
              : plate.reference_indexes,
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
  const content = buildScenePlatePlanContent(args);
  const client = getAnthropic();
  const resp = await client.messages
    .stream({
      model: STORYBOARD_MODEL,
      max_tokens: 8000,
      system: SCENE_PLATE_PLAN_SYSTEM_PROMPT,
      tools: [SCENE_PLATE_PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'plan_scene_plates' },
      messages: [{ role: 'user', content }],
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

async function callPhase2Anthropic({ beat, characters, direction, directorNotes, referenceInputs, plate }) {
  const userText = buildScenePlateCritiqueUserText({ beat, characters, direction, directorNotes, referenceInputs, plate });
  const client = getAnthropic();
  const resp = await client.messages
    .stream({
      model: STORYBOARD_MODEL,
      max_tokens: 6000,
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
        ? await phase2Override(plate, { beat, characters, direction, directorNotes, referenceInputs })
        : await callPhase2Anthropic({ beat, characters, direction, directorNotes, referenceInputs, plate });
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
  const images = normalizeScenePlanImages(expanded, { max: MAX_SCENE_IMAGE_COUNT })
    .map(({ reference_indexes, ...rest }) => ({
      ...rest,
      reference_image_ids: resolveReferenceIndexes(reference_indexes, referenceInputs),
    }));
  warnNonVerbatimQuotes(images, beat);
  emit({ phase: 'critiquing', step: 'critique_complete', total: images.length, message: `${images.length} plate${images.length === 1 ? '' : 's'} ready for review.` });
  return { images };
}

// Map a plate's 1-based reference_indexes to the ids of the supplied reference
// inputs. Out-of-range indexes and inputs without a usable id drop silently.
function resolveReferenceIndexes(indexes, referenceInputs = []) {
  const out = [];
  for (const n of indexes || []) {
    const r = referenceInputs[n - 1];
    const id = String(r?.id ?? r?._id ?? '');
    if (id) out.push(id);
  }
  return out;
}
