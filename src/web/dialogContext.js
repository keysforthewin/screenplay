// Shared steering-context assembler for dialogue operations.
//
// `buildDialogContext(beat)` returns one formatted text block describing
// everything the model should know before it writes, regenerates, or critiques
// dialogue for a beat:
//   - the logline (plot title + synopsis)
//   - the project-level dialogue style / influences (plot.dialogue_style)
//   - cross-beat continuity: the previous beat and its closing lines
//   - per-beat steering (beat.dialog_notes)
//   - character bios for the beat's speakers
//
// Generation, per-line regeneration, and the critic all consume this so the
// steering inputs stay consistent across operations.

import { getPlot } from '../mongo/plots.js';
import { listCharacters } from '../mongo/characters.js';
import { listDialogs } from '../mongo/dialogs.js';
import { stripMarkdown } from '../util/markdown.js';

const PREV_BEAT_LINE_LIMIT = 6;

// Format one character's bio block: a `## Name` heading followed by
// `hollywood_actor` (if set) and every non-empty custom field.
export function formatCharacterBio(c) {
  const plainName = stripMarkdown(c?.name || '').trim();
  if (!plainName) return '';
  const lines = [`## ${plainName}`];
  const actor = stripMarkdown(c.hollywood_actor || '').trim();
  if (actor) lines.push(`hollywood_actor: ${actor}`);
  const fields = c.fields && typeof c.fields === 'object' ? c.fields : {};
  for (const [key, raw] of Object.entries(fields)) {
    const value = stripMarkdown(typeof raw === 'string' ? raw : '').trim();
    if (!value) continue;
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

// Resolve character docs for the speakers named on the beat, beat-listed names
// first then everyone else, deduped case-insensitively on the stripped name.
export async function loadCharacterDocs(projectId, characterNames) {
  const seen = new Set();
  const out = [];
  const all = await listCharacters(projectId).catch(() => []);
  const allByKey = new Map();
  for (const c of all || []) {
    const key = stripMarkdown(c.name || '').toLowerCase();
    if (key) allByKey.set(key, c);
  }
  for (const raw of characterNames || []) {
    const key = stripMarkdown(raw || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const c = allByKey.get(key);
    if (c) out.push(c);
  }
  for (const c of all || []) {
    const key = stripMarkdown(c.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function previousBeat(plot, beat) {
  const order = Number(beat?.order);
  if (!Number.isFinite(order)) return null;
  const earlier = (plot.beats || [])
    .filter((b) => Number.isFinite(Number(b.order)) && Number(b.order) < order)
    .sort((a, b) => Number(b.order) - Number(a.order));
  return earlier[0] || null;
}

export async function buildDialogContext(projectId, beat) {
  const plot = await getPlot(projectId).catch(() => null);
  const sections = [];

  // Logline.
  const title = stripMarkdown(plot?.title || '').trim();
  const synopsis = stripMarkdown(plot?.synopsis || '').trim();
  if (title || synopsis) {
    const lines = ['# Story'];
    if (title) lines.push(`Title: ${title}`);
    if (synopsis) lines.push(`Logline: ${synopsis}`);
    sections.push(lines.join('\n'));
  }

  // Project dialogue style / influences.
  const style = stripMarkdown(plot?.dialogue_style || '').trim();
  if (style) {
    sections.push(['# Dialogue style & influences', style].join('\n'));
  }

  // Cross-beat continuity: the previous beat and its closing lines.
  const prev = plot ? previousBeat(plot, beat) : null;
  if (prev) {
    const lines = ['# The previous beat'];
    const prevName = stripMarkdown(prev.name || '').trim() || 'Untitled';
    const prevDesc = stripMarkdown(prev.desc || '').trim();
    lines.push(`Beat #${prev.order}: ${prevName}${prevDesc ? ` — ${prevDesc}` : ''}`);
    const prevDialogs = await listDialogs({ beatId: prev._id }).catch(() => []);
    const tail = prevDialogs.slice(-PREV_BEAT_LINE_LIMIT);
    if (tail.length) {
      lines.push('Its dialogue ended:');
      for (const d of tail) {
        const speaker = stripMarkdown(d.character || '').trim() || '(unknown)';
        const body = stripMarkdown(d.body || '').trim();
        if (body) lines.push(`  ${speaker}: ${body}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  // Per-beat dialogue notes.
  const notes = stripMarkdown(beat?.dialog_notes || '').trim();
  if (notes) {
    sections.push(['# Dialogue notes for this beat', notes].join('\n'));
  }

  // Character bios.
  const characters = await loadCharacterDocs(projectId, beat?.characters || []);
  const bios = characters.map(formatCharacterBio).filter(Boolean);
  if (bios.length) {
    sections.push(
      [
        '# Characters in this story',
        "Use these bios to inform each speaker's voice. Use a character's exact name when they speak.",
        '',
        bios.join('\n\n'),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}
