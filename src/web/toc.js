import { stripMarkdown } from '../util/markdown.js';

function plainKey(s) {
  return stripMarkdown(s || '').toLowerCase();
}

function bodyIsEmpty(body) {
  return !stripMarkdown(String(body || '')).trim();
}

export function buildTocResponse(
  characters,
  beats,
  notesCount,
  storyboardCounts,
  dialogCounts,
) {
  const counts = storyboardCounts || new Map();
  const dialogs = dialogCounts || new Map();
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
        beats: beatsByCharacterKey.get(plain.toLowerCase()) || [],
      };
    }),
    beats: sortedBeats.map((b) => ({
      _id: b._id,
      order: b.order,
      name: b.name,
      plain_name: stripMarkdown(b.name || ''),
      body_empty: bodyIsEmpty(b.body),
      storyboard_count: counts.get(b._id?.toString?.()) || 0,
      dialog_count: dialogs.get(b._id?.toString?.()) || 0,
    })),
    notes_count: notesCount || 0,
  };
}
