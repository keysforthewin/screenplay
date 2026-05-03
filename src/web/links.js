import { config } from '../config.js';
import { stripMarkdown } from '../util/markdown.js';

function publicBase() {
  return (config.web.publicBaseUrl || `http://localhost:${config.web.port}`).replace(/\/+$/, '');
}

export function characterUrl(character) {
  if (!character?.name) return null;
  const slug = stripMarkdown(character.name).trim();
  if (!slug) return null;
  return `${publicBase()}/character/${encodeURIComponent(slug)}`;
}

export function beatUrl(beat) {
  if (!beat || !Number.isFinite(beat.order)) return null;
  return `${publicBase()}/beat/${beat.order}`;
}

export function notesUrl() {
  return `${publicBase()}/notes`;
}

export function withSpaLink(text, url) {
  if (!url) return text;
  return `${String(text).replace(/\s+$/, '')}\nEdit in browser: ${url}`;
}
