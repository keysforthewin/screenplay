import { config } from '../config.js';
import { stripMarkdown } from '../util/markdown.js';

function publicBase() {
  return (config.web.publicBaseUrl || `http://localhost:${config.web.port}`).replace(/\/+$/, '');
}

// '/p/<encodeURIComponent(title)>' path segment for a project-scoped SPA URL.
// Falsy/blank titles produce no segment: the SPA redirects legacy un-prefixed
// paths into the viewer's last-used project, so links built by not-yet-migrated
// callers remain functional.
function projectSegment(projectTitle) {
  if (typeof projectTitle !== 'string') return '';
  const t = projectTitle.trim();
  if (!t) return '';
  return `/p/${encodeURIComponent(t)}`;
}

export function spaBaseUrl() {
  return publicBase();
}

export function homeUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/`;
}

export function libraryUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/library`;
}

export function characterUrl(projectTitle, character) {
  if (!character?.name) return null;
  const slug = stripMarkdown(character.name).trim();
  if (!slug) return null;
  return `${publicBase()}${projectSegment(projectTitle)}/character/${encodeURIComponent(slug)}`;
}

export function beatUrl(projectTitle, beat) {
  if (!beat || !Number.isFinite(beat.order)) return null;
  return `${publicBase()}${projectSegment(projectTitle)}/beat/${beat.order}`;
}

export function storyboardUrl(projectTitle, beat) {
  if (!beat || !Number.isFinite(beat.order)) return null;
  return `${publicBase()}${projectSegment(projectTitle)}/storyboard/${beat.order}`;
}

export function notesUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/notes`;
}

export function aboutUrl(projectTitle) {
  return `${publicBase()}${projectSegment(projectTitle)}/about`;
}

export function withSpaLink(text, url) {
  if (!url) return text;
  return `${String(text).replace(/\s+$/, '')}\nEdit in browser: ${url}`;
}
