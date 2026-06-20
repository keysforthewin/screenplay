// Shared character-bio formatter.
//
// Renders one character's sheet as a `## Name` heading followed by
// `hollywood_actor` (if set) and every non-empty custom field. Consumed by the
// SPA dialogue-context assembler (src/web/dialogContext.js) and the agent's
// writing-context loader (src/agent/writingContext.js), so the bio shape stays
// identical across both paths.

import { stripMarkdown } from './markdown.js';

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
