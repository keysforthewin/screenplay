// Thin composition layer wrapping announceMediaEvent so route handlers in
// entityRoutes.js can fire announcements in one line. Each helper resolves
// the entity label + SPA URL and pulls the SPA username from req.session.

import { announceMediaEvent, announceText } from '../discord/announcer.js';
import { beatUrl, characterUrl, notesUrl, libraryUrl, storyboardUrl } from './links.js';
import { stripMarkdown } from '../util/markdown.js';
import { logger } from '../log.js';

function usernameFromReq(req) {
  return req?.session?.username || 'Someone';
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

function noteLabel(note) {
  if (!note) return 'Director’s notes';
  const text = stripMarkdown(note.text || '').trim();
  const head = text ? text.slice(0, 60) : null;
  return head ? `Director’s notes: ${head}` : 'Director’s notes';
}

function storyboardLabel(beat, storyboard) {
  const orderSegment = storyboard && Number.isFinite(storyboard.order)
    ? ` (shot ${storyboard.order + 1})`
    : '';
  return `Storyboard — ${beatLabel(beat)}${orderSegment}`;
}

function fire(payload) {
  // Intentionally not awaited: announcements never block API responses.
  announceMediaEvent(payload).catch((e) =>
    logger.warn(`announceHelpers: announceMediaEvent threw: ${e?.message || e}`),
  );
}

export function announceBeatMedia({
  req,
  beat,
  verb,
  imageFileId,
  mediaFileId,
  mediaLabel,
  prompt,
}) {
  fire({
    username: usernameFromReq(req),
    verb,
    entityLabel: beatLabel(beat),
    entityUrl: beatUrl(req?.projectTitle ?? null, beat),
    imageFileId,
    mediaFileId,
    mediaLabel,
    prompt,
  });
}

export function announceCharacterMedia({
  req,
  character,
  verb,
  imageFileId,
  mediaFileId,
  mediaLabel,
  prompt,
}) {
  fire({
    username: usernameFromReq(req),
    verb,
    entityLabel: characterLabel(character),
    entityUrl: characterUrl(req?.projectTitle ?? null, character),
    imageFileId,
    mediaFileId,
    mediaLabel,
    prompt,
  });
}

export function announceNoteMedia({
  req,
  note,
  verb,
  imageFileId,
  mediaFileId,
  mediaLabel,
  prompt,
}) {
  fire({
    username: usernameFromReq(req),
    verb,
    entityLabel: noteLabel(note),
    entityUrl: notesUrl(req?.projectTitle ?? null),
    imageFileId,
    mediaFileId,
    mediaLabel,
    prompt,
  });
}

export function announceStoryboardMedia({
  req,
  beat,
  storyboard,
  verb,
  imageFileId,
  mediaFileId,
  mediaLabel,
  prompt,
}) {
  fire({
    username: usernameFromReq(req),
    verb,
    entityLabel: storyboardLabel(beat, storyboard),
    entityUrl: storyboardUrl(req?.projectTitle ?? null, beat),
    imageFileId,
    mediaFileId,
    mediaLabel,
    prompt,
  });
}

export function announceLibraryMedia({
  req,
  verb,
  imageFileId,
  mediaFileId,
  mediaLabel,
  prompt,
}) {
  fire({
    username: usernameFromReq(req),
    verb,
    entityLabel: 'Library',
    entityUrl: libraryUrl(req?.projectTitle ?? null),
    imageFileId,
    mediaFileId,
    mediaLabel,
    prompt,
  });
}

// Plain-text summary line for batch operations (storyboard generation, etc.)
// where per-item embeds would spam the channel.
export function announceBatchSummary({ req, message }) {
  const who = usernameFromReq(req);
  announceText(`${who} ${message}`).catch((e) =>
    logger.warn(`announceHelpers: announceText threw: ${e?.message || e}`),
  );
}

// Variant used by async job-completion callbacks where there is no `req`.
// Caller passes the username string (captured at job submit time and
// threaded through the job record).
export function announceMediaEventDirect(payload) {
  fire(payload);
}
