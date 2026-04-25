import { findAllCharacters } from '../mongo/characters.js';
import { getPlot } from '../mongo/plots.js';
import { getCharacterTemplate } from '../mongo/prompts.js';

function preview(text, n = 140) {
  if (!text) return '';
  const t = String(text).trim();
  if (!t) return '';
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function pickDescriptiveField(character, templateFieldNames) {
  const fields = character.fields || {};
  const preferred = ['background_story', 'arc', 'origin_story', 'events'];
  const order = [
    ...preferred.filter((n) => templateFieldNames.includes(n)),
    ...templateFieldNames.filter((n) => !preferred.includes(n)),
  ];
  for (const fname of order) {
    const v = fields[fname];
    if (v && String(v).trim()) {
      return { field: fname, preview: preview(Array.isArray(v) ? v.join(', ') : v) };
    }
  }
  return null;
}

function summarizeCharacter(c, templateFieldNames) {
  const filled = templateFieldNames.filter((n) => {
    const v = c.fields?.[n];
    return v !== undefined && v !== null && String(v).toString().trim() !== '';
  });
  const casting = c.plays_self
    ? 'plays self'
    : c.hollywood_actor
      ? `played by ${c.hollywood_actor}`
      : 'played by (unspecified)';
  const flavor = pickDescriptiveField(c, templateFieldNames);
  const images = c.images || [];
  return {
    _id: c._id?.toString?.() || null,
    name: c.name,
    casting,
    own_voice: !!c.own_voice,
    flavor,
    filled_field_count: filled.length,
    total_field_count: templateFieldNames.length,
    image_count: images.length,
    has_main_image: !!c.main_image_id,
  };
}

function summarizeBeat(b, currentBeatId) {
  const isCurrent = !!(currentBeatId && b._id && currentBeatId.equals
    ? currentBeatId.equals(b._id)
    : currentBeatId === b._id);
  return {
    _id: b._id?.toString?.() || null,
    order: b.order,
    name: b.name,
    desc: b.desc || '',
    body_length: (b.body || '').length,
    has_body: !!(b.body || '').trim(),
    characters: b.characters || [],
    image_count: (b.images || []).length,
    has_main_image: !!b.main_image_id,
    is_current: isCurrent,
  };
}

export async function buildOverview() {
  const [characters, plot, template] = await Promise.all([
    findAllCharacters(),
    getPlot(),
    getCharacterTemplate(),
  ]);

  const templateFieldNames = (template?.fields || [])
    .map((f) => f.name)
    .filter((n) => !['name', 'plays_self', 'hollywood_actor', 'own_voice'].includes(n));

  const beats = [...(plot.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const currentBeatId = plot.current_beat_id || null;
  const currentBeat = currentBeatId
    ? beats.find((b) => b._id && currentBeatId.equals(b._id)) || null
    : null;

  const beatSummaries = beats.map((b) => summarizeBeat(b, currentBeatId));
  const characterSummaries = characters.map((c) => summarizeCharacter(c, templateFieldNames));

  return {
    plot: {
      synopsis: plot.synopsis || '',
      synopsis_filled: !!(plot.synopsis || '').trim(),
      notes_preview: preview(plot.notes, 200),
      notes_length: (plot.notes || '').length,
      current_beat: currentBeat
        ? { _id: currentBeat._id.toString(), order: currentBeat.order, name: currentBeat.name }
        : null,
    },
    counts: {
      characters: characterSummaries.length,
      characters_with_main_image: characterSummaries.filter((c) => c.has_main_image).length,
      beats: beatSummaries.length,
      beats_with_body: beatSummaries.filter((b) => b.has_body).length,
      beats_with_main_image: beatSummaries.filter((b) => b.has_main_image).length,
    },
    character_template_fields: templateFieldNames,
    characters: characterSummaries,
    beats: beatSummaries,
  };
}
