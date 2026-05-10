import { stripMarkdown } from '../util/markdown.js';

function plainKey(s) {
  return stripMarkdown(s || '').toLowerCase();
}

function bodyIsEmpty(body) {
  return !stripMarkdown(String(body || '')).trim();
}

// Build a lowercase, markdown-stripped text blob from a list of parts. Used
// to back the TOC filter when the user types a substring that doesn't match
// the rendered label — e.g. typing a phrase from a beat's body or a dialog
// line should still bring the matching entry into view.
function blob(...parts) {
  return parts
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => stripMarkdown(p))
    .join('\n')
    .toLowerCase();
}

// Aggregate every text value reachable from a character doc. Custom template
// fields live under `fields.<x>` (per CLAUDE.md) so we walk them generically.
function characterSearchText(c) {
  const fieldsObj = c.fields && typeof c.fields === 'object' ? c.fields : {};
  const fieldValues = Object.values(fieldsObj)
    .filter((v) => typeof v === 'string')
    .join('\n');
  return blob(c.name, c.hollywood_actor, fieldValues);
}

export function buildTocResponse(
  characters,
  beats,
  notesCount,
  storyboardCounts,
  dialogCounts,
  options = {},
) {
  const counts = storyboardCounts || new Map();
  const dialogs = dialogCounts || new Map();
  const allDialogs = options.allDialogs || [];
  const allStoryboards = options.allStoryboards || [];

  // Aggregate per-beat searchable text from dialog lines (body + speaker)
  // and storyboard scene prompts. Keyed by hex beat id so the lookup matches
  // the way storyboard_count / dialog_count are keyed.
  const dialogTextByBeat = new Map();
  for (const d of allDialogs) {
    const k = d.beat_id?.toString?.();
    if (!k) continue;
    const prev = dialogTextByBeat.get(k) || '';
    dialogTextByBeat.set(
      k,
      prev + (prev ? '\n' : '') + blob(d.character, d.body),
    );
  }
  const storyboardTextByBeat = new Map();
  for (const sb of allStoryboards) {
    const k = sb.beat_id?.toString?.();
    if (!k) continue;
    const prev = storyboardTextByBeat.get(k) || '';
    storyboardTextByBeat.set(
      k,
      prev + (prev ? '\n' : '') + blob(sb.text_prompt),
    );
  }

  const beatsByCharacterKey = new Map();
  const sortedBeats = [...(beats || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const b of sortedBeats) {
    const ref = { order: b.order, plain_name: stripMarkdown(b.name || '') };
    for (const raw of b.characters || []) {
      const key = plainKey(raw);
      if (!key) continue;
      const list = beatsByCharacterKey.get(key) || [];
      list.push(ref);
      beatsByCharacterKey.set(key, list);
    }
  }

  return {
    characters: (characters || []).map((c) => {
      const plain = stripMarkdown(c.name || '');
      return {
        _id: c._id,
        name: c.name,
        plain_name: plain,
        main_image_id: c.main_image_id || null,
        beats: beatsByCharacterKey.get(plain.toLowerCase()) || [],
        search_text: characterSearchText(c),
      };
    }),
    beats: sortedBeats.map((b) => {
      const id = b._id?.toString?.() || '';
      const charactersJoined = (b.characters || [])
        .map((s) => stripMarkdown(String(s || '')))
        .join(' ');
      return {
        _id: b._id,
        order: b.order,
        name: b.name,
        plain_name: stripMarkdown(b.name || ''),
        body_empty: bodyIsEmpty(b.body),
        storyboard_count: counts.get(id) || 0,
        dialog_count: dialogs.get(id) || 0,
        search_text: blob(b.name, b.body, charactersJoined),
        dialog_search_text: dialogTextByBeat.get(id) || '',
        storyboard_search_text: storyboardTextByBeat.get(id) || '',
      };
    }),
    notes_count: notesCount || 0,
  };
}
