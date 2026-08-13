import { getBeat, getPlot } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { getSet } from '../mongo/sets.js';
import { beatUrl, characterUrl, notesUrl, setUrl } from '../web/links.js';

const CURRENT_BEAT = ':current:';
const MAX_URLS = 10;

const TOOL_TO_ENTITY = {
  // beats — explicit identifier
  get_beat: { kind: 'beat', from: 'identifier', allowCurrent: true },
  update_beat: { kind: 'beat', from: 'identifier' },
  set_current_beat: { kind: 'beat', from: 'identifier' },

  // beats — current-beat by default
  get_current_beat: { kind: 'beat', current: true },

  // beats — `beat` field, may default to current
  set_beat_body: { kind: 'beat', from: 'beat', allowCurrent: true },
  edit_beat_body: { kind: 'beat', from: 'beat', allowCurrent: true },
  append_to_beat_body: { kind: 'beat', from: 'beat', allowCurrent: true },
  link_character_to_beat: { kind: 'beat', from: 'beat', allowCurrent: true },
  unlink_character_from_beat: { kind: 'beat', from: 'beat', allowCurrent: true },
  link_set_to_beat: { kind: 'beat', from: 'beat', allowCurrent: true },
  unlink_set_from_beat: { kind: 'beat', from: 'beat', allowCurrent: true },

  // beats — resolved by name post-hoc
  create_beat: { kind: 'beat', from: 'name' },

  // characters
  get_character: { kind: 'character', from: 'identifier' },
  update_character: { kind: 'character', from: 'identifier' },
  revise_character: { kind: 'character', from: 'identifier' },
  create_character: { kind: 'character', from: 'name' },
  bulk_update_character_field: { kind: 'character', bulk: true },

  // sets
  get_set: { kind: 'set', from: 'identifier' },
  create_set: { kind: 'set', from: 'name' },
  delete_set: { kind: 'set', from: 'identifier' },

  // sets — image/attachment tools, all identify the target via `set`
  add_set_image: { kind: 'set', from: 'set' },
  list_set_images: { kind: 'set', from: 'set' },
  set_main_set_image: { kind: 'set', from: 'set' },
  remove_set_image: { kind: 'set', from: 'set' },
  attach_library_image_to_set: { kind: 'set', from: 'set' },
  add_set_attachment: { kind: 'set', from: 'set' },
  list_set_attachments: { kind: 'set', from: 'set' },
  remove_set_attachment: { kind: 'set', from: 'set' },
  attach_library_attachment_to_set: { kind: 'set', from: 'set' },

  // director's notes (singleton page — any touch resolves to /notes)
  list_director_notes: { kind: 'notes' },
  add_director_note: { kind: 'notes' },
  edit_director_note: { kind: 'notes' },
  remove_director_note: { kind: 'notes' },
  reorder_director_notes: { kind: 'notes' },
  add_director_note_image: { kind: 'notes' },
  list_director_note_images: { kind: 'notes' },
  set_main_director_note_image: { kind: 'notes' },
  remove_director_note_image: { kind: 'notes' },
  add_director_note_attachment: { kind: 'notes' },
  list_director_note_attachments: { kind: 'notes' },
  remove_director_note_attachment: { kind: 'notes' },
  attach_library_image_to_director_note: { kind: 'notes' },
};

export function recordEntityTouch(toolName, input, touched) {
  const desc = TOOL_TO_ENTITY[toolName];
  if (!desc || !touched) return;
  const inp = input && typeof input === 'object' ? input : {};

  if (desc.kind === 'notes') {
    touched.notes = true;
    return;
  }

  if (desc.kind === 'beat') {
    if (desc.current) {
      touched.beats.add(CURRENT_BEAT);
      return;
    }
    const raw = String(inp[desc.from] ?? '').trim();
    if (raw) {
      touched.beats.add(raw);
    } else if (desc.allowCurrent) {
      touched.beats.add(CURRENT_BEAT);
    }
    return;
  }

  if (desc.kind === 'character') {
    if (desc.bulk) {
      const updates = Array.isArray(inp.updates) ? inp.updates : [];
      for (const u of updates) {
        const ref = String(u?.character ?? u?.identifier ?? '').trim();
        if (ref) touched.characters.add(ref);
      }
      return;
    }
    const raw = String(inp[desc.from] ?? '').trim();
    if (raw) touched.characters.add(raw);
    return;
  }

  if (desc.kind === 'set') {
    const raw = String(inp[desc.from] ?? '').trim();
    if (raw) touched.sets.add(raw);
  }
}

async function safeCall(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function resolveEntityLinks(touched, context = null) {
  if (!touched) return [];
  const urls = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    urls.push(u);
  };

  if (touched.notes) {
    push(notesUrl(context?.projectTitle));
  }

  let currentBeatPromise = null;
  for (const ref of touched.beats || []) {
    if (urls.length >= MAX_URLS) break;
    let beat;
    if (ref === CURRENT_BEAT) {
      if (!currentBeatPromise) {
        currentBeatPromise = safeCall(async () => {
          const plot = await getPlot(context?.projectId);
          if (!plot?.current_beat_id) return null;
          return (
            (plot.beats || []).find(
              (b) => b._id && plot.current_beat_id.equals(b._id),
            ) || null
          );
        });
      }
      beat = await currentBeatPromise;
    } else {
      beat = await safeCall(() => getBeat(context?.projectId, ref));
    }
    push(beatUrl(context?.projectTitle, beat));
  }

  for (const ref of touched.characters || []) {
    if (urls.length >= MAX_URLS) break;
    const character = await safeCall(() => getCharacter(context?.projectId, ref));
    push(characterUrl(context?.projectTitle, character));
  }

  for (const ref of touched.sets || []) {
    if (urls.length >= MAX_URLS) break;
    const set = await safeCall(() => getSet(context?.projectId, ref));
    push(setUrl(context?.projectTitle, set));
  }

  return urls.slice(0, MAX_URLS);
}

export function appendEntityLinks(text, urls) {
  if (!Array.isArray(urls) || urls.length === 0) return text;
  const base = String(text ?? '');
  const fresh = urls.filter((u) => u && !base.includes(u));
  if (fresh.length === 0) return text;
  const trimmed = base.replace(/\s+$/, '');
  if (fresh.length === 1) {
    return `${trimmed}\n\nEdit in browser: ${fresh[0]}`;
  }
  return `${trimmed}\n\nEdit in browser:\n${fresh.map((u) => `- ${u}`).join('\n')}`;
}

export function createTouchedEntities() {
  return { beats: new Set(), characters: new Set(), sets: new Set(), notes: false };
}

// Drop every touch accumulated so far. Called by the agent loop when a
// set_project succeeds mid-turn: pre-switch refs belong to the previous
// project and must not be resolved into links against the new one.
export function clearTouchedEntities(touched) {
  if (!touched) return;
  touched.beats.clear();
  touched.characters.clear();
  touched.sets.clear();
  touched.notes = false;
}
