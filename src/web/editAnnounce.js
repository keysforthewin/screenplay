// Announcements for SPA writing edits (beat body/name/desc), character text
// edits, and beat cast changes. Pure helpers here; the Hocuspocus-facing cache
// and fire functions live in the second half of this file (added in Task 3).

import { ObjectId } from 'mongodb';
import { stripMarkdown } from '../util/markdown.js';
import { beatUrl, characterUrl } from './links.js';
import { getDb } from '../mongo/client.js';
import { getProjectById } from '../mongo/projects.js';
import { fragmentToMarkdown } from './headlessEditor.js';
import { announceMediaEvent } from '../discord/announcer.js';
import { claimAnnouncement } from '../mongo/editAnnouncements.js';
import { logger } from '../log.js';

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

// ── Stateful layer (Hocuspocus-facing) ──────────────────────────────────────

// roomName -> { type: 'beat'|'character', announceFields: string[], values: Map }
const roomCache = new Map();

export function _resetCacheForTests() {
  roomCache.clear();
}

// Called from afterLoadDocument. Captures the announce-relevant field list and
// their baseline markdown so the initial seed is never mistaken for an edit.
export function primeRoomCache(documentName, desc) {
  const announceFields = announceFieldsForDesc(desc);
  if (!announceFields.length) return;
  const values = new Map();
  for (const f of announceFields) values.set(f, String(desc.seed?.[f] ?? ''));
  roomCache.set(documentName, { type: desc.type, announceFields, values });
}

export function forgetRoomCache(documentName) {
  roomCache.delete(documentName);
}

function fire(payload) {
  announceMediaEvent(payload).catch((e) =>
    logger.warn(`editAnnounce: announceMediaEvent threw: ${e?.message || e}`),
  );
}

async function lookupBeat(beatIdHex) {
  const plot = await getDb()
    .collection('plots')
    .findOne({ 'beats._id': new ObjectId(beatIdHex) });
  if (!plot) return null;
  const beat = (plot.beats || []).find((b) => b._id?.toString?.() === beatIdHex);
  if (!beat) return null;
  return { projectId: plot.project_id ? String(plot.project_id) : null, beat };
}

async function lookupCharacter(charIdHex) {
  const c = await getDb().collection('characters').findOne({ _id: new ObjectId(charIdHex) });
  if (!c) return null;
  return { projectId: c.project_id ? String(c.project_id) : null, character: c };
}

async function projectTitleFor(projectId) {
  if (!projectId) return null;
  const proj = await getProjectById(projectId).catch(() => null);
  return proj?.title ?? null;
}

// Best-effort: called from the Hocuspocus onChange hook on every doc update.
export async function handleRoomChange({ documentName, document, context }) {
  try {
    const state = roomCache.get(documentName);
    if (!state) return; // not a primed beat/character room

    let anyChanged = false;
    for (const field of state.announceFields) {
      let md;
      try {
        md = fragmentToMarkdown(document, field);
      } catch {
        continue;
      }
      if (md !== state.values.get(field)) {
        anyChanged = true;
        state.values.set(field, md);
      }
    }
    if (!anyChanged) return;

    // Attribution: bot writes and seed/server origins never announce. (Cache is
    // already updated above, so the next human edit diffs against fresh text.)
    if (context?.actor === 'bot') return;
    const editor = context?.user?.name;
    if (!editor) return;

    const m = documentName.match(/^(beat|character):([a-f0-9]{24})$/i);
    if (!m) return;
    const [, type, id] = m;

    if (type === 'beat') {
      const found = await lookupBeat(id);
      if (!found?.projectId) return;
      if (!(await claimAnnouncement({ projectId: found.projectId, targetType: 'beat', targetId: id, editor }))) return;
      const projectTitle = await projectTitleFor(found.projectId);
      fire(buildWritingPayload({ who: editor, beat: found.beat, projectTitle }));
    } else {
      const found = await lookupCharacter(id);
      if (!found?.projectId) return;
      if (!(await claimAnnouncement({ projectId: found.projectId, targetType: 'character', targetId: id, editor }))) return;
      const projectTitle = await projectTitleFor(found.projectId);
      fire(buildCharacterPayload({ who: editor, character: found.character, projectTitle }));
    }
  } catch (e) {
    logger.warn(`editAnnounce handleRoomChange failed ${documentName}: ${e?.message || e}`);
  }
}

// Best-effort: called from PATCH /beat/:id after a cast change is detected.
export async function maybeAnnounceCast({ projectId, projectTitle, beat, editor, added, removed }) {
  try {
    if (!editor) return;
    if (!(added?.length) && !(removed?.length)) return;
    const beatIdHex = beat?._id?.toString?.();
    if (!beatIdHex) return;
    if (!(await claimAnnouncement({ projectId, targetType: 'beat', targetId: beatIdHex, editor }))) return;
    fire(buildCastPayload({ who: editor, beat, projectTitle, added, removed }));
  } catch (e) {
    logger.warn(`editAnnounce maybeAnnounceCast failed: ${e?.message || e}`);
  }
}
