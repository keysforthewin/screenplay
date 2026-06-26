// Announcements for SPA writing edits (beat body/name/desc), character text
// edits, and beat cast changes. Pure helpers here; the Hocuspocus-facing cache
// and fire functions live in the second half of this file (added in Task 3).

import { stripMarkdown } from '../util/markdown.js';
import { beatUrl, characterUrl } from './links.js';

const BEAT_WRITING_FIELDS = ['name', 'body', 'desc'];

// Which fragments in a resolved room count as an announce-worthy text edit.
// Beats: name/body/desc only (excludes scene_bible.* and image/attachment
// captions). Characters: every text field except media caption fragments.
export function announceFieldsForDesc(desc) {
  if (!desc) return [];
  if (desc.type === 'beat') {
    return (desc.fields || []).filter((f) => BEAT_WRITING_FIELDS.includes(f));
  }
  if (desc.type === 'character') {
    return (desc.fields || []).filter(
      (f) => !f.startsWith('image:') && !f.startsWith('attachment:'),
    );
  }
  return [];
}

export function diffCast(oldNames, newNames) {
  const norm = (s) => String(s).trim().toLowerCase();
  const oldSet = new Set((oldNames || []).map(norm));
  const newSet = new Set((newNames || []).map(norm));
  const added = (newNames || []).filter((n) => !oldSet.has(norm(n)));
  const removed = (oldNames || []).filter((n) => !newSet.has(norm(n)));
  return { added, removed };
}

export function joinNames(names) {
  const arr = (names || []).map((n) => stripMarkdown(String(n)).trim()).filter(Boolean);
  if (arr.length <= 1) return arr.join('');
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}

export function beatLabel(beat) {
  if (!beat) return 'a beat';
  const name = stripMarkdown(beat.name || '').trim();
  const order = Number.isFinite(beat.order) ? `Beat ${beat.order}` : 'Beat';
  return name ? `${order}: ${name}` : order;
}

export function characterLabel(character) {
  if (!character) return 'a character';
  const name = stripMarkdown(character.name || '').trim() || 'character';
  return `Character: ${name}`;
}

export function buildWritingPayload({ who, beat, projectTitle }) {
  return {
    username: who,
    verb: 'edited the writing in',
    entityLabel: beatLabel(beat),
    entityUrl: beatUrl(projectTitle ?? null, beat),
  };
}

export function buildCharacterPayload({ who, character, projectTitle }) {
  return {
    username: who,
    verb: 'edited',
    entityLabel: characterLabel(character),
    entityUrl: characterUrl(projectTitle ?? null, character),
  };
}

export function buildCastPayload({ who, beat, projectTitle, added, removed }) {
  const a = joinNames(added);
  const r = joinNames(removed);
  let verb;
  let prompt;
  if (a && !r) {
    verb = `added ${a} to`;
  } else if (r && !a) {
    verb = `removed ${r} from`;
  } else {
    verb = 'changed the cast of';
    const parts = [];
    if (a) parts.push(`Added ${a}`);
    if (r) parts.push(`removed ${r}`);
    prompt = `${parts.join('; ')}.`;
  }
  return {
    username: who,
    verb,
    entityLabel: beatLabel(beat),
    entityUrl: beatUrl(projectTitle ?? null, beat),
    ...(prompt ? { prompt } : {}),
  };
}
