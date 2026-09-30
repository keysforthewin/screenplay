// Shared beat-planning helpers: resolving a beat's characters and sets,
// loading the project-wide steering (director's notes, directorial voice,
// dialogue), and formatting it all into the context block an LLM planner
// reads. Used by the Prompts-tab cut planner (beatContext.js, cutPlanner.js,
// cutStartFrames.js, referenceCatalog.js), the image-sheet planners, the
// scene-bible autofill and the set-description generator.
//
// (Extracted from the retired storyboard pipeline.)

import { logger } from '../log.js';
import { getCharacter } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { readImageBuffer } from '../mongo/images.js';
import { listBeats } from '../mongo/plots.js';
import { getSet } from '../mongo/sets.js';
import { stripMarkdown } from '../util/markdown.js';
import { estimateSpeechSeconds } from './shotTiming.js';

const ANTHROPIC_OK = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_DIRECTION_CHARS = 4000;

function sanitizeDirection(s) {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_DIRECTION_CHARS
    ? trimmed.slice(0, MAX_DIRECTION_CHARS)
    : trimmed;
}

// Thrown by anything that needs the per-beat lock while another job holds it.
export class BeatBusyError extends Error {
  constructor(beatId) {
    super(`Work already in progress for beat ${beatId}`);
    this.code = 'BEAT_BUSY';
  }
}

// Fetch the project-wide director's notes for inclusion in a planner prompt.
// Swallows errors (returns []) so a transient DB hiccup doesn't fail the whole
// job — the notes are guidance, not load-bearing.
export async function loadDirectorNotesForPlanner(projectId) {
  try {
    const doc = await getDirectorNotes(projectId);
    return Array.isArray(doc?.notes) ? doc.notes : [];
  } catch (e) {
    logger.warn(`beat plan: loadDirectorNotesForPlanner failed: ${e?.message || e}`);
    return [];
  }
}

// Resolve every character named in a beat's `characters` list to its current
// Mongo doc (one resolution path for every planner and picker).
export async function findCharactersInBeat(projectId, beat) {
  const out = [];
  for (const raw of beat?.characters || []) {
    const stripped = stripMarkdown(raw || '').trim();
    if (!stripped) continue;
    try {
      const c = await getCharacter(projectId, stripped);
      if (c) out.push(c);
    } catch (e) {
      logger.warn(`beat plan: character lookup "${stripped}" failed: ${e.message}`);
    }
  }
  return out;
}

// Resolve every set named in a beat's `sets` list to its current Mongo doc —
// the set counterpart of findCharactersInBeat.
export async function findSetsInBeat(projectId, beat) {
  const out = [];
  for (const raw of beat?.sets || []) {
    const stripped = stripMarkdown(raw || '').trim();
    if (!stripped) continue;
    try {
      const s = await getSet(projectId, stripped);
      if (s) out.push(s);
    } catch (e) {
      logger.warn(`beat plan: set lookup "${stripped}" failed: ${e.message}`);
    }
  }
  return out;
}

// The reverse of findSetsInBeat: every beat whose `sets` roster names this
// set (markdown-stripped, case-insensitive — the same rule getSet resolves
// by). Returns full embedded beat docs in beat order.
export async function findBeatsReferencingSet(projectId, set) {
  const nameLower = set?.name_lower || stripMarkdown(set?.name || '').trim().toLowerCase();
  if (!nameLower) return [];
  const beats = await listBeats(projectId);
  return beats.filter((beat) =>
    (beat?.sets || []).some((raw) => stripMarkdown(String(raw || '')).trim().toLowerCase() === nameLower),
  );
}

// Load image bytes + content type + stored description from GridFS metadata.
// The description (when present, populated by the vision seed worker) is
// returned alongside the bytes so callers can build concordant text+image
// references instead of having to infer everything from pixels alone.
export async function loadImageInput(imageId) {
  try {
    const result = await readImageBuffer(imageId);
    if (!result) return null;
    const { buffer, file } = result;
    const ct = file.contentType || file.metadata?.contentType;
    if (!ANTHROPIC_OK.has(ct)) return null;
    const description = String(file.metadata?.description || '').trim();
    const name = String(file.metadata?.name || '').trim();
    return { buffer, contentType: ct, _id: file._id, description, name };
  } catch (e) {
    logger.warn(`beat plan: read image ${imageId} failed: ${e.message}`);
    return null;
  }
}

// Clip a markdown field to a plain, length-bounded one-liner for prompt
// context — strips markdown, collapses whitespace, truncates on a word boundary,
// and appends an ellipsis. Returns '' for empty/missing input.
export function clipField(raw, max = 300) {
  const s = stripMarkdown(typeof raw === 'string' ? raw : '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Casting markers that mean the actor is NOT the on-screen visual likeness, so
// we must not present them as "played by" (the image model would paint the
// voice actor's face). The character's own look field carries the visuals.
export const NON_VISUAL_CASTING = /\b(voice[\s-]?only|voice[\s-]?over|v\.?o\.?|motion[\s-]?capture|mo-?cap)\b/i;

// Format the beat's linked sets for the planner/expander context: name plus a
// clipped look line from the set's description. Sets are the reusable
// settings/locations whose artwork backs the location plates.
function formatSetLines(sets) {
  if (!sets?.length) return '(no sets linked to this beat)';
  return sets
    .map((s) => {
      const name = stripMarkdown(s.name || '').trim();
      const look = clipField(s.description);
      const lines = [`- ${name}`];
      if (look) lines.push(`    look: ${look}`);
      return lines.join('\n');
    })
    .join('\n');
}

// Format the character list the same way for every LLM call so all passes
// see consistent context. Surfaces the appearance-
// bearing fields the image prompts need — the actor (the strongest likeness
// handle, skipped for voice-only/mocap casting), the visual prose in a custom
// `description` field or `background_story`, `memes`, and `faction` as a light
// wardrobe/aesthetic hint. Prompts refer to characters by these, never the name.
function formatCharacterLines(characters) {
  if (!characters?.length) return '(no named characters in this beat)';
  return characters
    .map((c) => {
      const name = stripMarkdown(c.name || '').trim();
      const actorClean = stripMarkdown(
        typeof c.hollywood_actor === 'string' ? c.hollywood_actor : '',
      )
        .replace(/\s+/g, ' ')
        .trim();
      // Voice-only / mocap casting isn't a face — don't surface it as "played
      // by", or the image model paints the wrong likeness.
      const actor = NON_VISUAL_CASTING.test(actorClean) ? '' : clipField(actorClean, 80);
      const role = clipField(c.fields?.role, 80);
      const look = clipField(c.fields?.description || c.fields?.background_story);
      const memes = clipField(c.fields?.memes, 160);
      const faction = clipField(c.fields?.faction, 80);
      // Name-line suffix: actor likeness is the strongest handle; otherwise a
      // role label if one exists.
      const suffix = actor ? ` — played by ${actor}` : role ? ` — ${role}` : '';
      const lines = [`- ${name}${suffix}`];
      if (look) lines.push(`    look: ${look}`);
      if (memes) lines.push(`    memes: ${memes}`);
      if (faction) lines.push(`    faction: ${faction}`);
      return lines.join('\n');
    })
    .join('\n');
}

// The beat's spoken lines, for TURN ORDER and DELIVERY only. The words
// themselves must never reach a generated prompt — real voices are recorded
// and lip-synced in post — but the expander cannot choreograph who speaks when
// without seeing the exchange, and `direction` is an authored performance note
// that is otherwise wasted.
// One line per dialog, numbered by POSITION IN THE FULL LIST (index + 1) so the
// numbers the planner returns in dialog_lines map straight back onto the
// dialogs array — including any lines this formatter skipped. Each line carries
// an audio mark so the planner knows which lines are fixed in time.
export function formatDialogLines(dialogs) {
  if (!Array.isArray(dialogs) || !dialogs.length) return null;
  const items = dialogs
    .map((d, i) => {
      const speaker = stripMarkdown(typeof d?.character === 'string' ? d.character : '').trim();
      const body = clipField(d?.body, 400);
      if (!speaker && !body) return null;
      const dir = clipField(d?.direction, 300);
      const audio = formatDialogAudioMark(d);
      const head = `${i + 1}. ${speaker || 'UNKNOWN'}: ${body || '(no line)'} ${audio}`;
      return dir ? `${head}\n       direction: ${dir}` : head;
    })
    .filter(Boolean);
  if (!items.length) return null;
  return items.map((t) => `  ${t}`).join('\n');
}

// "[audio: 4.2s recorded]" when a real recording exists (its length is the
// ground truth for the covering shot), "[audio: none — est. 3s]" otherwise.
export function formatDialogAudioMark(d) {
  const dur = Number(d?.audio_duration_seconds);
  if (d?.audio_file_id && Number.isFinite(dur) && dur > 0) {
    return `[audio: ${dur.toFixed(1)}s recorded]`;
  }
  if (d?.audio_file_id) return '[audio: recorded, length unknown]';
  const est = estimateSpeechSeconds([d]);
  return est > 0 ? `[audio: none — est. ${Math.ceil(est)}s]` : '[audio: none]';
}

// The project-wide directorial voice (plots.directorial_voice) — the single
// directing hand every beat inherits. Swallowed errors return '' for the same
// reason the notes loader does: it is steering, not load-bearing state.
export async function loadDirectorialVoice(projectId) {
  try {
    const { getPlot } = await import('../mongo/plots.js');
    const plot = await getPlot(projectId);
    return stripMarkdown(typeof plot?.directorial_voice === 'string' ? plot.directorial_voice : '').trim();
  } catch (e) {
    logger.warn(`beat plan: loadDirectorialVoice failed: ${e?.message || e}`);
    return '';
  }
}

// Fetch the beat's dialogue for the planner prompts. Swallows errors (returns
// []) for the same reason loadDirectorNotesForPlanner does — context, not
// load-bearing state.
export async function loadDialogsForPlanner(projectId, beatId) {
  try {
    const { listDialogs, ensureDialogAudioDurations } = await import('../mongo/dialogs.js');
    const rows = await listDialogs({ projectId, beatId });
    if (!Array.isArray(rows)) return [];
    // Legacy rows recorded before durations were probed on attach: fill them
    // in once so the planner sees real lengths. Best-effort.
    try {
      return await ensureDialogAudioDurations(projectId, rows);
    } catch (e) {
      logger.warn(`beat plan: ensureDialogAudioDurations failed: ${e?.message || e}`);
      return rows;
    }
  } catch (e) {
    logger.warn(`beat plan: loadDialogsForPlanner failed: ${e?.message || e}`);
    return [];
  }
}

export function formatDirectorNotes(directorNotes) {
  if (!Array.isArray(directorNotes) || !directorNotes.length) return null;
  const items = directorNotes
    .map((n) => {
      const text = stripMarkdown(typeof n?.text === 'string' ? n.text : '').trim();
      return text || null;
    })
    .filter(Boolean);
  if (!items.length) return null;
  return items.map((t) => `- ${t}`).join('\n');
}

// The compact beat context block the image-sheet planner reads.
//
// directorNotes is the project-wide list (from getDirectorNotes(projectId).notes) —
// every note appears in every shot's prompt because notes are global tone /
// style / continuity guidance, not scene-scoped.
export function buildBeatContextBlock({ beat, characters, sets = [], direction, directorNotes = [], dialogs = [], directorialVoice = '' }) {
  const lines = [];
  // The project's single directing hand leads the block: it biases every choice
  // beneath it, so it has to be read before the beat rather than after.
  const voice = stripMarkdown(typeof directorialVoice === 'string' ? directorialVoice : '').trim();
  if (voice) {
    lines.push(
      '# Directorial voice (project-wide — every shot of every beat is shot by this same hand)',
      'Bias every camera, lighting, blocking, and performance choice toward this voice. Deviating',
      'from it should be a deliberate signal that a major turn has arrived, never an accident.',
      '',
      voice,
      '',
    );
  }
  lines.push(
    `# Beat #${beat.order}: ${stripMarkdown(beat.name || '') || 'Untitled'}`,
    '',
    'Beat description:',
    stripMarkdown(beat.desc || '') || '(none)',
    '',
    'Beat body:',
    stripMarkdown(beat.body || '') || '(none)',
    '',
    'Characters in this beat:',
    formatCharacterLines(characters),
    '',
    'Sets in this beat (the settings/locations shots take place in):',
    formatSetLines(sets),
  );
  const notesBlock = formatDirectorNotes(directorNotes);
  if (notesBlock) {
    lines.push('');
    lines.push("Director's notes (project-wide guidance — apply to every shot):");
    lines.push(notesBlock);
  }
  const dialogBlock = formatDialogLines(dialogs);
  if (dialogBlock) {
    lines.push('');
    lines.push(
      'Dialogue in this beat — use it for TURN ORDER (who speaks, in what sequence), who is on which line, and how each line is delivered.',
      'NEVER write these words, or any words, into a prompt: the real performance is recorded by actors and lip-synced in post.',
    );
    lines.push(dialogBlock);
  }
  const cleanDirection = sanitizeDirection(direction);
  if (cleanDirection) {
    lines.push('');
    lines.push("Director's commentary:");
    lines.push(cleanDirection);
  }
  return lines.join('\n');
}
