import { stripMarkdown } from '../util/markdown.js';

function plainKey(s) {
  return stripMarkdown(s || '').toLowerCase();
}

export function buildTocResponse(characters, beats, notesCount) {
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
    })),
    notes_count: notesCount || 0,
  };
}
