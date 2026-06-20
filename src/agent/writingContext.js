// Scoped steering-context assembler for the agent's `load_writing_context` tool.
//
// `buildWritingContext(projectId, beat, characterNames)` returns one formatted
// text block giving the agent everything it needs before composing or editing a
// beat body:
//   - the beat itself (name, desc, dialog_notes, body — preview when large)
//   - the logline (plot title + synopsis) and project dialogue style
//   - FULL bios for the *named* characters only (typically the <5 the passage
//     features) — NOT every character linked to the beat, which can be too many.
//
// Distinct from src/web/dialogContext.js, which loads every beat character and
// the previous beat's closing lines for the SPA dialogue generator. This one is
// scoped to the subset the agent declares it is writing about.

import { getPlot } from '../mongo/plots.js';
import { getCharacter } from '../mongo/characters.js';
import { stripMarkdown } from '../util/markdown.js';
import { formatCharacterBio } from '../util/characterBio.js';
import { truncateForPreview } from '../util/textWindow.js';
import { config } from '../config.js';
import { SCREENPLAY_STYLE_GUIDE } from './screenplayStyle.js';

function formatBody(beat) {
  const body = String(beat?.body || '');
  if (!body.trim()) return 'Body:\n(empty — nothing written yet.)';
  const threshold = config.agent?.bodyPreviewThreshold ?? 8000;
  if (body.length <= threshold) return `Body:\n${body}`;
  const t = truncateForPreview(body, threshold);
  return (
    `Body (large — ${t.totalChars} chars, showing the opening only; use outline_beat_body / ` +
    `search_in_beat_body / read_beat_body for the rest, or get_beat with full_body:true):\n${t.preview}`
  );
}

export async function buildWritingContext(projectId, beat, characterNames = []) {
  const sections = [];

  // The beat itself.
  const beatLines = ['# Beat'];
  const name = stripMarkdown(beat?.name || '').trim() || 'Untitled';
  const desc = stripMarkdown(beat?.desc || '').trim();
  const order = Number.isFinite(Number(beat?.order)) ? `#${beat.order}: ` : '';
  beatLines.push(`Beat ${order}${name}${desc ? ` — ${desc}` : ''}`);
  const notes = stripMarkdown(beat?.dialog_notes || '').trim();
  if (notes) beatLines.push(`Dialogue notes for this beat: ${notes}`);
  beatLines.push('');
  beatLines.push(formatBody(beat));
  sections.push(beatLines.join('\n'));

  // Logline.
  const plot = await getPlot(projectId).catch(() => null);
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

  // Full bios for the named characters only, deduped case-insensitively.
  const seen = new Set();
  const bios = [];
  const unknown = [];
  for (const raw of characterNames || []) {
    const key = stripMarkdown(raw || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const c = await getCharacter(projectId, String(raw)).catch(() => null);
    const bio = c ? formatCharacterBio(c) : '';
    if (bio) bios.push(bio);
    else unknown.push(stripMarkdown(raw || '').trim() || String(raw));
  }
  if (bios.length || unknown.length) {
    const lines = [
      '# Characters featured in this passage',
      "Use these bios to inform each speaker's voice. Use a character's exact name when they speak.",
      '',
    ];
    if (bios.length) lines.push(bios.join('\n\n'));
    for (const u of unknown) lines.push(`(No character on file named "${u}".)`);
    sections.push(lines.join('\n'));
  }

  // Screenplay-format craft guide — last section so it is the freshest guidance
  // in context right before the agent composes/edits the body.
  sections.push(['# Writing in screenplay format', SCREENPLAY_STYLE_GUIDE].join('\n'));

  return sections.join('\n\n');
}
