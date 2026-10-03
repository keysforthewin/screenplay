// src/web/beatContext.js
// Pass 0 of the scene/cut planner: ONE context block holding the ENTIRE beat
// and everything around it, assembled once per job and reused verbatim by
// every LLM pass (scenes → cuts → prose → start frames) so the passes share
// a prompt cache. Unlike the storyboard planner's buildBeatContextBlock this
// never clips the body and shows every character field the template holds:
// the user asked for the whole beat in context, so the only cap is a safety
// ceiling that WARNS rather than truncates.

import { logger } from '../log.js';
import { listBeats } from '../mongo/plots.js';
import { renderSceneBibleBlock } from '../mongo/sceneBible.js';
import { stripMarkdown } from '../util/markdown.js';
import { WARDROBE_FIELD, wardrobeText } from './wardrobe.js';
import {
  findCharactersInBeat,
  findSetsInBeat,
  formatDialogLines,
  formatDirectorNotes,
  loadDialogsForPlanner,
  loadDirectorNotesForPlanner,
  loadDirectorialVoice,
  NON_VISUAL_CASTING,
} from './beatPlanShared.js';

// Past this many characters the body is still sent whole, but the job
// records a warning so a runaway beat is visible rather than silently slow.
export const BEAT_BODY_SAFETY_CAP = 60000;
// Per-field cap for character/set prose. 2000 is "the whole field" for every
// template field in practice; it only guards against pasted novels.
export const FIELD_CAP = 2000;
const SET_DESCRIPTION_CAP = 4000;
const DIRECTION_CAP = 4000;

const SLUGLINE_RE = /^\s*(?:INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.|EXT\.|INT\b|EXT\b|I\/E\.?)\s*[^\n]*$/i;

// Fountain-style sluglines in the body, in order: the deterministic hint the
// scene-breaking pass is told to respect. Returns [{ line, text }].
export function findSluglines(body) {
  const out = [];
  // Split the RAW body first: stripMarkdown collapses paragraphs, which would
  // lose the line numbers the scene planner reports back.
  const lines = String(body || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = stripMarkdown(lines[i]).trim();
    if (!t) continue;
    if (SLUGLINE_RE.test(t)) out.push({ line: i + 1, text: t });
  }
  return out;
}

function clip(raw, max) {
  const s = stripMarkdown(typeof raw === 'string' ? raw : raw == null ? '' : String(raw))
    .replace(/\s+\n/g, '\n')
    .trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

export function cleanDirection(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return s.length > DIRECTION_CAP ? s.slice(0, DIRECTION_CAP) : s;
}

// Every character field the template holds, not a curated subset. The actor
// likeness leads because it is the strongest visual handle; voice-only /
// mocap casting is surfaced as a voice, never as a face.
export function formatCharacterFull(c, { beat = null } = {}) {
  const name = stripMarkdown(c?.name || '').trim() || 'Unnamed';
  const actorClean = stripMarkdown(typeof c?.hollywood_actor === 'string' ? c.hollywood_actor : '')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = [];
  if (actorClean && NON_VISUAL_CASTING.test(actorClean)) {
    lines.push(`- ${name} — voice casting: ${clip(actorClean, 120)} (not a face; use the described look)`);
  } else if (actorClean) {
    lines.push(`- ${name} — played by ${clip(actorClean, 120)} (use this likeness as the visual handle)`);
  } else {
    lines.push(`- ${name}`);
  }
  if (c?.plays_self) lines.push('    plays themself (a real person; keep their actual look)');
  // The wardrobe lock (src/web/wardrobe.js) leads the fields: the beat's
  // override when it has one, else the character's default — the exact words
  // every lock line, visual handle and still prompt must reuse.
  const lock = wardrobeText(c, beat);
  if (lock) lines.push(`    wardrobe (LOCKED — use these exact words in every lock line, handle and still): ${lock}`);
  const fields = c?.fields && typeof c.fields === 'object' ? c.fields : {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    if (key === WARDROBE_FIELD) continue;
    const v = clip(value, FIELD_CAP);
    if (!v) continue;
    const label = key.replace(/_/g, ' ');
    lines.push(`    ${label}: ${v.replace(/\n+/g, ' / ')}`);
  }
  return lines.join('\n');
}

export function formatSetFull(s) {
  const name = stripMarkdown(s?.name || '').trim() || 'Unnamed set';
  const desc = clip(s?.description, SET_DESCRIPTION_CAP);
  const lines = [`- ${name}`];
  if (desc) lines.push(`    ${desc.replace(/\n+/g, ' / ')}`);
  return lines.join('\n');
}

function formatNeighbour(label, b) {
  if (!b) return `${label}: (none)`;
  const name = stripMarkdown(b.name || '').trim() || 'Untitled';
  const desc = clip(b.desc, 400);
  return `${label}: #${b.order} ${name}${desc ? ` — ${desc.replace(/\n+/g, ' ')}` : ''}`;
}

// Pure: the text block. Everything the loaders gather comes in as arguments
// so tests can build it without Mongo.
export function buildFullBeatContextText({
  beat,
  characters = [],
  sets = [],
  directorNotes = [],
  dialogs = [],
  directorialVoice = '',
  neighbours = { previous: null, next: null },
  sluglines = null,
  direction = '',
}) {
  const lines = [];
  const voice = stripMarkdown(typeof directorialVoice === 'string' ? directorialVoice : '').trim();
  if (voice) {
    lines.push(
      '# Directorial voice (project-wide — every cut of every beat is shot by this same hand)',
      'Bias every camera, lighting, blocking and performance choice toward this voice. Deviating from it is a deliberate signal that a major turn has arrived, never an accident.',
      '',
      voice,
      '',
    );
  }
  const body = stripMarkdown(beat?.body || '');
  const slugs = sluglines || findSluglines(beat?.body || '');
  lines.push(
    `# Beat #${beat?.order ?? '?'}: ${stripMarkdown(beat?.name || '') || 'Untitled'}`,
    '',
    'Beat description:',
    stripMarkdown(beat?.desc || '') || '(none)',
    '',
    'Neighbouring beats (for the scope firewall — what has already happened and what is reserved for later; never stage it here):',
    formatNeighbour('Previous beat', neighbours?.previous),
    formatNeighbour('Next beat', neighbours?.next),
    '',
    '# Beat body (the ENTIRE beat, screenplay format — sluglines mark location and time, action lines carry blocking, mini-slugs name sub-locations)',
    body || '(empty)',
    '',
  );
  if (slugs.length) {
    lines.push(
      'Sluglines found in the body, in order (the scene boundaries the script itself declares):',
      ...slugs.map((s) => `- line ${s.line}: ${s.text}`),
      '',
    );
  } else {
    lines.push('Sluglines found in the body: none — the beat plays as one continuous scene unless the prose changes location or time.', '');
  }
  lines.push(
    '# Characters in this beat (every field the cast template holds)',
    characters.length ? characters.map((c) => formatCharacterFull(c, { beat })).join('\n') : '(no named characters in this beat)',
    '',
    '# Sets in this beat (the settings/locations; their artwork is the reference pool)',
    sets.length ? sets.map(formatSetFull).join('\n') : '(no sets linked to this beat)',
  );
  const bible = renderSceneBibleBlock(beat?.scene_bible);
  if (bible) {
    lines.push('', '# Scene bible (a look this beat already carries — inherit it, do not restate it)', bible);
  }
  const notesBlock = formatDirectorNotes(directorNotes);
  if (notesBlock) {
    lines.push('', "# Director's notes (project-wide guidance — every one applies to every cut)", notesBlock);
  }
  const dialogBlock = formatDialogLines(dialogs);
  if (dialogBlock) {
    lines.push(
      '',
      '# Dialogue in this beat, NUMBERED by position',
      'For TURN ORDER, who speaks which line, and delivery. The words are recorded by real actors and lip-synced in post: NEVER write them, or any words, into a prompt. Lines with a recorded length are fixed in time.',
      dialogBlock,
    );
  } else {
    lines.push('', '# Dialogue in this beat', '(none — no lines to cover)');
  }
  const dir = cleanDirection(direction);
  if (dir) {
    lines.push('', "# Director's commentary for this run", dir);
  }
  return lines.join('\n');
}

async function loadNeighbours(projectId, beat) {
  try {
    const beats = await listBeats(projectId);
    const idx = beats.findIndex((b) => String(b._id) === String(beat._id));
    if (idx < 0) return { previous: null, next: null };
    return { previous: beats[idx - 1] || null, next: beats[idx + 1] || null };
  } catch (e) {
    logger.warn(`beatContext: neighbours failed: ${e?.message || e}`);
    return { previous: null, next: null };
  }
}

// Loader: gathers everything and returns the block plus the raw parts the
// passes need again (dialogs for numbering, characters/sets for name checks).
export async function loadFullBeatContext({ projectId, beat, direction = '' }) {
  const warnings = [];
  const [characters, sets, directorNotes, dialogs, directorialVoice, neighbours] = await Promise.all([
    findCharactersInBeat(projectId, beat),
    findSetsInBeat(projectId, beat),
    loadDirectorNotesForPlanner(projectId),
    loadDialogsForPlanner(projectId, beat._id),
    loadDirectorialVoice(projectId),
    loadNeighbours(projectId, beat),
  ]);
  const bodyLen = stripMarkdown(beat.body || '').length;
  if (bodyLen > BEAT_BODY_SAFETY_CAP) {
    warnings.push(
      `Beat body is ${bodyLen.toLocaleString()} characters (over the ${BEAT_BODY_SAFETY_CAP.toLocaleString()} safety ceiling); it was sent whole, but consider splitting the beat.`,
    );
  }
  const sluglines = findSluglines(beat.body || '');
  const text = buildFullBeatContextText({
    beat,
    characters,
    sets,
    directorNotes,
    dialogs,
    directorialVoice,
    neighbours,
    sluglines,
    direction,
  });
  return { text, characters, sets, directorNotes, dialogs, directorialVoice, neighbours, sluglines, warnings };
}
