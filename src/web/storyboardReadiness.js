// Advisory pre-generation "readiness report" for a beat's storyboard: does the
// beat's text have visual backing in its linked characters and sets? Two
// halves — deterministic inventory checks (pure, no I/O) and ONE cheap
// forced-tool LLM pass that reads the beat text and flags visual elements
// (locations, props, characters, effects) with no matching entity, no artwork,
// or a thin description.
//
// STRICTLY ADVISORY: buildReadinessReport never throws, and the storyboard
// generation job runs it inside its own try/catch before the destructive
// wipe — a readiness failure never gates generation. The report persists on
// the beat (beats.$.readiness_report, the setBeatSceneBible precedent) so the
// SPA can show it on load and re-check on demand via the polling job below.

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';
import { logger } from '../log.js';
import { stripMarkdown } from '../util/markdown.js';
import { getBeat, setBeatReadinessReport } from '../mongo/plots.js';
import { findCharactersInBeat, findSetsInBeat, clipField } from './storyboardGenerate.js';

// Cheap tier — this is triage, not judgment (same tier the frame-reference
// scorer uses).
const GAP_MODEL = config.anthropic.enhancerModel;

const GAP_TOOL = {
  name: 'report_visual_gaps',
  description:
    'Report visual elements in the beat text that lack backing in the linked characters/sets.',
  input_schema: {
    type: 'object',
    properties: {
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            element: { type: 'string', description: 'The visual element from the beat text, e.g. "the dragon", "grand ballroom".' },
            element_kind: {
              type: 'string',
              enum: ['location', 'prop', 'character', 'effect', 'wardrobe', 'vehicle', 'other'],
            },
            issue: {
              type: 'string',
              enum: ['no_matching_entity', 'entity_no_artwork', 'entity_thin_description'],
            },
            matched_entity: {
              type: ['string', 'null'],
              description: 'The character/set name this element matched, or null when nothing matches.',
            },
            note: { type: 'string', description: 'One sentence: what to add and where.' },
          },
          required: ['element', 'element_kind', 'issue', 'note'],
          additionalProperties: false,
        },
      },
      summary: { type: 'string', description: 'One or two sentences summarizing overall visual readiness.' },
    },
    required: ['gaps', 'summary'],
    additionalProperties: false,
  },
};

const GAP_SYSTEM = [
  'You are a production designer doing a pre-visualization inventory for ONE screenplay beat.',
  'You get the beat text plus a manifest of the characters and sets (settings/locations) linked to it,',
  'with flags for whether each has artwork, reference images, and a filled-in description,',
  'and a per-entity list of its artwork plates with what each plate depicts.',
  'Find the VISUAL elements the beat text calls for — locations, notable props, characters, effects,',
  'wardrobe, vehicles — that the storyboard image generator will have nothing to anchor on:',
  'either no matching character/set exists, the match has no artwork to use as a reference,',
  'or the match has only a thin description. An element already depicted in a listed plate IS backed —',
  'never report it as a gap. Ignore elements a generic image model handles fine',
  '(ordinary furniture, weather, unnamed extras). Be selective — only report gaps an author should act on.',
  'Return your findings via the report_visual_gaps tool.',
].join(' ');

function plain(s) {
  return stripMarkdown(String(s || '')).trim();
}

function doneArtworks(doc) {
  return (doc?.artworks || []).filter((a) => a?.status === 'done' && a.result_image_id);
}

function hasDoneArtwork(doc) {
  return doneArtworks(doc).length > 0;
}

// Artwork descriptions are what the frame-reference scorer reads when picking
// which plates to feed a frame (src/web/frameReferences.js). A gallery where
// none are described is one the scorer has to guess at. One described plate is
// enough to stay quiet — this is advice, not a completeness audit.
function describedArtworkCount(doc) {
  return doneArtworks(doc).filter((a) => String(a.description || '').trim()).length;
}

// `code` is host-prefixed ('character_…' / 'set_…') so the SPA's ReadinessPanel
// can build the right entity link from the code alone.
function artworkDescriptionCheck(doc, name, hostLabel, code) {
  const total = doneArtworks(doc).length;
  if (!total || describedArtworkCount(doc) > 0) return null;
  return check('info', code, name,
    `${hostLabel} has ${total} artwork ${total === 1 ? 'plate' : 'plates'} but no descriptions — `
    + 'frames pick references by description, so add one (or hit Describe on the Artwork tab).');
}

function check(severity, code, subject, message) {
  return { severity, code, subject, message };
}

// Pure inventory diff. `characters`/`sets` are the RESOLVED docs; missing
// roster names are detected by comparing against beat.characters / beat.sets.
export function runDeterministicChecks({ beat, characters = [], sets = [] }) {
  const checks = [];
  const resolvedCharNames = new Set(characters.map((c) => plain(c.name).toLowerCase()));
  const resolvedSetNames = new Set(sets.map((s) => plain(s.name).toLowerCase()));

  for (const raw of beat?.characters || []) {
    const name = plain(raw);
    if (name && !resolvedCharNames.has(name.toLowerCase())) {
      checks.push(check('warn', 'missing_character', name,
        `"${name}" is on the beat's cast list but no character with that name exists.`));
    }
  }
  for (const raw of beat?.sets || []) {
    const name = plain(raw);
    if (name && !resolvedSetNames.has(name.toLowerCase())) {
      checks.push(check('warn', 'missing_set', name,
        `"${name}" is on the beat's set list but no set with that name exists.`));
    }
  }

  for (const c of characters) {
    const name = plain(c.name);
    const hasVisuals =
      (c.images || []).length > 0 ||
      hasDoneArtwork(c) ||
      (c.character_sheet_image_ids || []).length > 0;
    if (!hasVisuals) {
      checks.push(check('warn', 'character_no_visuals', name,
        `${name} has no images, artwork, or character sheets — frames featuring them have no likeness reference.`));
    }
    const desc = plain(c.fields?.description) || plain(c.fields?.background_story);
    if (!desc) {
      checks.push(check('info', 'character_thin_description', name,
        `${name} has no description/background text to steer their look.`));
    }
    const artDesc = artworkDescriptionCheck(c, name, name, 'character_artwork_no_description');
    if (artDesc) checks.push(artDesc);
  }

  for (const s of sets) {
    const name = plain(s.name);
    if (!hasDoneArtwork(s)) {
      if ((s.images || []).length > 0) {
        checks.push(check('info', 'set_reference_only', name,
          `Set "${name}" has reference images but no generated artwork — only artwork feeds storyboard frames. Generate plates on its Artwork tab.`));
      } else {
        checks.push(check('warn', 'set_no_artwork', name,
          `Set "${name}" has no artwork (or reference images) — shots there have no location reference.`));
      }
    }
    if (!plain(s.description)) {
      checks.push(check('info', 'set_thin_description', name,
        `Set "${name}" has no description to steer its look.`));
    }
    const artDesc = artworkDescriptionCheck(s, name, `Set "${name}"`, 'set_artwork_no_description');
    if (artDesc) checks.push(artDesc);
  }

  if (!(beat?.sets || []).length) {
    checks.push(check('info', 'no_sets_linked', null,
      'No sets are linked to this beat — the storyboard generator will have no location references.'));
  }
  if (!plain(beat?.body)) {
    checks.push(check('info', 'empty_body', null,
      'The beat body is empty — the planner will only have the name/description to work from.'));
  }

  return checks;
}

// ── LLM gap pass ───────────────────────────────────────────────────────────

let gapReporterOverride = null;
export function _setGapReporterForTests(fn) {
  gapReporterOverride = fn;
}

function plateTally(doc) {
  return `described plates: ${describedArtworkCount(doc)}/${doneArtworks(doc).length}`;
}

// One indented line per done plate saying what it DEPICTS — without these the
// gap reporter flags elements (a starfield, a night version of a set) that an
// existing plate already covers. Same description||prompt fallback as the
// frame-reference candidates (src/web/frameReferences.js).
const MAX_MANIFEST_PLATES = 12;
function plateLines(doc) {
  const plates = doneArtworks(doc);
  const lines = plates.slice(0, MAX_MANIFEST_PLATES).map((a) => {
    const label = String(a.name || '').trim() || 'untitled';
    const depicts =
      clipField(String(a.description || '').trim() || String(a.prompt || '').trim(), 160)
      || '(no description)';
    return `    • plate "${label}": ${depicts}`;
  });
  if (plates.length > MAX_MANIFEST_PLATES) {
    lines.push(`    • …and ${plates.length - MAX_MANIFEST_PLATES} more plates`);
  }
  return lines;
}

// Exported for tests only — the gap reporter is the sole production caller.
export function rosterManifest(characters, sets) {
  const lines = [];
  lines.push('# Linked characters:');
  if (!characters.length) lines.push('(none)');
  for (const c of characters) {
    lines.push(
      `- ${plain(c.name)} — artwork: ${hasDoneArtwork(c) ? 'yes' : 'NO'}, ${plateTally(c)}, images: ${
        (c.images || []).length ? 'yes' : 'NO'
      }, description: ${clipField(c.fields?.description || c.fields?.background_story, 120) || '(none)'}`,
    );
    lines.push(...plateLines(c));
  }
  lines.push('', '# Linked sets (settings/locations):');
  if (!sets.length) lines.push('(none)');
  for (const s of sets) {
    lines.push(
      `- ${plain(s.name)} — artwork: ${hasDoneArtwork(s) ? 'yes' : 'NO'}, ${plateTally(s)}, images: ${
        (s.images || []).length ? 'yes' : 'NO'
      }, description: ${clipField(s.description, 120) || '(none)'}`,
    );
    lines.push(...plateLines(s));
  }
  return lines.join('\n');
}

async function reportVisualGaps({ beat, characters, sets }) {
  if (gapReporterOverride) return gapReporterOverride({ beat, characters, sets });
  const userText = [
    `# Beat: ${plain(beat.name) || 'Untitled'}`,
    '',
    'Description:',
    plain(beat.desc) || '(none)',
    '',
    'Body:',
    plain(beat.body) || '(none)',
    '',
    rosterManifest(characters, sets),
    '',
    'Report the visual gaps via the report_visual_gaps tool.',
  ].join('\n');
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: GAP_MODEL,
    max_tokens: 2000,
    system: GAP_SYSTEM,
    tools: [GAP_TOOL],
    tool_choice: { type: 'tool', name: 'report_visual_gaps' },
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const toolUse = (resp.content || []).find(
    (b) => b.type === 'tool_use' && b.name === 'report_visual_gaps',
  );
  if (!toolUse?.input || !Array.isArray(toolUse.input.gaps)) {
    throw new Error('gap reporter returned no tool call');
  }
  return {
    gaps: toolUse.input.gaps,
    summary: typeof toolUse.input.summary === 'string' ? toolUse.input.summary : '',
  };
}

// ── Report builder ─────────────────────────────────────────────────────────

// Never throws — the advisory contract. Any LLM failure lands as llm_error on
// an otherwise-complete report; a deterministic-check failure yields an empty
// checks list (should never happen in practice — the checks are pure).
export async function buildReadinessReport({ projectId, beat }) {
  let characters = [];
  let sets = [];
  try {
    characters = await findCharactersInBeat(projectId, beat);
    sets = await findSetsInBeat(projectId, beat);
  } catch (e) {
    logger.warn(`readiness: roster resolution failed: ${e.message}`);
  }
  let checks = [];
  try {
    checks = runDeterministicChecks({ beat, characters, sets });
  } catch (e) {
    logger.warn(`readiness: deterministic checks failed: ${e.message}`);
  }
  let gaps = [];
  let summary = '';
  let llm_error;
  try {
    const r = await reportVisualGaps({ beat, characters, sets });
    gaps = r.gaps;
    summary = r.summary;
  } catch (e) {
    llm_error = e.message;
    logger.warn(`readiness: gap reporter failed: ${e.message}`);
  }
  const warnings =
    checks.filter((c) => c.severity === 'warn').length +
    gaps.length;
  const infos = checks.filter((c) => c.severity === 'info').length;
  return {
    created_at: new Date(),
    model: GAP_MODEL,
    checks,
    gaps,
    summary,
    ...(llm_error ? { llm_error } : {}),
    counts: { warnings, infos },
  };
}

// ── Standalone polling job (POST /storyboards/readiness) ───────────────────
// Read-only: no beat lock needed. Same in-memory job-map pattern as the
// storyboard generation/critique jobs.

const jobs = new Map();

export function getReadinessJob(jobId) {
  return jobs.get(String(jobId)) || null;
}

export function _resetReadinessJobsForTests() {
  jobs.clear();
}

export async function startReadinessJob({ projectId, beatId }) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) {
    const err = new Error(`Beat not found: ${beatId}`);
    err.status = 404;
    throw err;
  }
  const jobId = randomUUID();
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    project_id: projectId,
    status: 'running',
    started_at: new Date(),
    finished_at: null,
    error: null,
    report: null,
  };
  jobs.set(jobId, job);
  (async () => {
    try {
      const report = await buildReadinessReport({ projectId, beat });
      job.report = report;
      await setBeatReadinessReport(projectId, beat._id, report).catch((e) =>
        logger.warn(`readiness: persist report failed: ${e.message}`),
      );
      job.status = 'done';
    } catch (e) {
      // buildReadinessReport never throws; this is a belt-and-braces net.
      job.status = 'error';
      job.error = e.message;
      logger.error(`readiness job ${jobId} crashed: ${e.message}`);
    } finally {
      job.finished_at = new Date();
    }
  })();
  return { job_id: jobId };
}
