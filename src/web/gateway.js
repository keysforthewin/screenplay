// gateway.js
//
// Single mutation gateway for editable entities. Both REST handlers (used by
// the SPA) and the agent loop's tool handlers route through this module so
// every change to a beat / character / director's note flows through the same
// path: write Mongo → mirror into y-doc → broadcast a stateless ping.
//
// Text mutations (body / name / desc / fields.<x> / note text) update the y-doc
// fragment via a headless Tiptap editor. The Hocuspocus onStoreDocument hook
// (in roomRegistry.persistFields) then writes the rendered markdown back to
// Mongo, so we don't need to write Mongo here for text fields — the
// round-trip is done in one direction.
//
// Non-text mutations (image add/remove, set main image, attachment add/remove,
// boolean toggles, etc.) call the existing Mongo helpers directly and then
// broadcast a stateless message of the form {type:'fields_updated', ...} to
// every client connected to the entity's room. The SPA listens for this and
// re-renders the affected widgets without a refetch.
//
// While a text mutation is being applied on behalf of the bot, the gateway
// briefly sets the room's awareness to mark the bot as a participant — clients
// see the bot's named caret in the field that's being edited.

import { ObjectId } from 'mongodb';
import { config } from '../config.js';
import { logger } from '../log.js';
import {
  getRoomDocument,
  withDirectDocument,
  broadcastRoomStateless,
  isHocuspocusRunning,
} from './hocuspocus.js';
import * as Plots from '../mongo/plots.js';
import { buildRoomName } from './roomRegistry.js';
import { resolveProjectId, getProjectById } from '../mongo/projects.js';

// Lazy-load the heavy headless-editor module (jsdom + Tiptap). It's only
// needed when Hocuspocus is actually running, which is never the case in
// unit tests, so deferring the import keeps test startup fast.
let _headlessEditor;
async function he() {
  if (!_headlessEditor) {
    _headlessEditor = await import('./headlessEditor.js');
  }
  return _headlessEditor;
}
import {
  pushBeatImage,
  setBeatMainImage,
  pullBeatImage,
  pushBeatAttachment,
  pullBeatAttachment,
  replaceBeatImage,
  getBeat,
} from '../mongo/plots.js';
import {
  getCharacter,
  createCharacter as mongoCreateCharacter,
  updateCharacter as mongoUpdateCharacter,
  pushCharacterImage,
  pullCharacterImage,
  replaceCharacterImage,
  pushCharacterAttachment,
  pullCharacterAttachment,
} from '../mongo/characters.js';
import {
  getSet,
  createSet as mongoCreateSet,
  updateSet as mongoUpdateSet,
  deleteSet as mongoDeleteSet,
  pushSetImage,
  pullSetImage,
  replaceSetImage,
  pushSetAttachment,
  pullSetAttachment,
} from '../mongo/sets.js';
import {
  createPendingArtwork as mongoCreatePendingArtwork,
  appendDoneArtwork as mongoAppendDoneArtwork,
  patchArtwork as mongoPatchArtwork,
  setArtworkStatus as mongoSetArtworkStatus,
  setArtworkResult as mongoSetArtworkResult,
  undoArtworkEdit as mongoUndoArtworkEdit,
  removeArtwork as mongoRemoveArtwork,
} from '../mongo/artworks.js';
import {
  getDirectorNotes,
  addDirectorNote as mongoAddDirectorNote,
  removeDirectorNote as mongoRemoveDirectorNote,
  pushDirectorNoteImage,
  pullDirectorNoteImage,
  setDirectorNoteMainImage,
  pushDirectorNoteAttachment,
  pullDirectorNoteAttachment,
} from '../mongo/directorNotes.js';
import {
  createDialog as mongoCreateDialog,
  updateDialog as mongoUpdateDialog,
  deleteDialog as mongoDeleteDialog,
  deleteDialogsForBeat as mongoDeleteDialogsForBeat,
  getDialog as mongoGetDialog,
  reorderDialogsForBeat as mongoReorderDialogs,
  listDialogs,
} from '../mongo/dialogs.js';
import {
  createVideoPrompt as mongoCreateVideoPrompt,
  updateVideoPrompt as mongoUpdateVideoPrompt,
  deleteVideoPrompt as mongoDeleteVideoPrompt,
  deleteVideoPromptsForBeat as mongoDeleteVideoPromptsForBeat,
  deleteVideoPromptsForScene as mongoDeleteVideoPromptsForScene,
  getVideoPrompt as mongoGetVideoPrompt,
  reorderVideoPromptsForBeat as mongoReorderVideoPrompts,
  recomputeCutOrderForBeat as mongoRecomputeCutOrder,
  reorderCutsInScene as mongoReorderCutsInScene,
  normalizeStartFrame,
} from '../mongo/videoPrompts.js';
import {
  createVideoScene as mongoCreateVideoScene,
  updateVideoScene as mongoUpdateVideoScene,
  deleteVideoScene as mongoDeleteVideoScene,
  deleteVideoScenesForBeat as mongoDeleteVideoScenesForBeat,
  getVideoScene as mongoGetVideoScene,
  reorderVideoScenesForBeat as mongoReorderVideoScenes,
  setVideoSceneVideo as mongoSetVideoSceneVideo,
  listVideoScenes,
} from '../mongo/videoScenes.js';
import {
  setMainCharacterImage,
  setCharacterWardrobeImage,
  removeCharacterImage,
  setMainSetImage,
  removeSetImage,
  detachImageFromCurrentOwner,
} from '../mongo/files.js';
import {
  setLibraryImageMeta,
  setOwnedImageMeta,
  setImageOwner,
  findImageFile,
  deleteImage,
  deleteImages,
} from '../mongo/images.js';
import { copyImageToNewOwner } from '../mongo/imageCopy.js';
import {
  setLibraryAttachmentMeta,
  setOwnedAttachmentMeta,
  findAttachmentFile,
  readAttachmentBuffer,
  attachExistingAttachmentToBeat,
  attachExistingAttachmentToCharacter,
  attachExistingAttachmentToDirectorNote,
  deleteAttachments,
} from '../mongo/attachments.js';
import { probeAudioDurationSeconds } from '../fal/videoPricing.js';
import { enqueueReindex } from '../rag/queue.js';
import { deleteEntity } from '../rag/indexer.js';
import { stripMarkdown, linesToHardBreaks } from '../util/markdown.js';
import { currentEditor } from './editAttribution.js';
import {
  maybeAnnounceCast,
  diffCast,
  announceBeatLifecycle,
  announceBeatsReordered,
  announceSetLifecycle,
  announceCharacterLifecycle,
} from './editAnnounce.js';

let botDisplayName = 'Screenplay Bot';

export function setBotDisplayName(name) {
  if (typeof name === 'string' && name.trim()) botDisplayName = name.trim();
}

export function getBotDisplayName() {
  return botDisplayName;
}

// Context passed to withDirectDocument → surfaces as `context` in the Hocuspocus
// onChange announce hook (editAnnounce.handleRoomChange). When a text edit is
// performed on behalf of a logged-in web user (chat agent or any AI feature
// running inside a runAsEditor scope), attribute it to them so the edit is
// announced + throttled exactly like a manual keyboard edit. Otherwise it's a
// bot/Discord edit and stays silent (handleRoomChange skips actor === 'bot').
export function gatewayEditContext() {
  const editor = currentEditor();
  return editor ? { actor: 'web-user', user: { name: editor } } : { actor: 'bot' };
}

function botAwarenessUser(field) {
  return {
    name: botDisplayName,
    color: config.web.botColor,
    isBot: true,
    field: field || null,
  };
}

// Briefly attach bot awareness so connected clients see the bot's caret while
// the mutation is being applied. No-op if no clients are currently in the room.
function withBotPresence(roomName, field, fn) {
  const doc = getRoomDocument(roomName);
  let awareness;
  if (doc?.awareness) {
    awareness = doc.awareness;
    try {
      awareness.setLocalStateField('user', botAwarenessUser(field));
    } catch (e) {
      logger.warn(`gateway awareness set failed ${roomName}: ${e.message}`);
    }
  }
  let result;
  try {
    result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(() => {
        if (awareness) {
          try {
            awareness.setLocalState(null);
          } catch {}
        }
      });
    }
    return result;
  } catch (e) {
    if (awareness) {
      try {
        awareness.setLocalState(null);
      } catch {}
    }
    throw e;
  } finally {
    if (awareness && (!result || typeof result.then !== 'function')) {
      try {
        awareness.setLocalState(null);
      } catch {}
    }
  }
}

function broadcastFieldsUpdated(roomName, payload) {
  return broadcastRoomStateless(roomName, {
    type: 'fields_updated',
    ...payload,
  });
}

const SINGLETON_ENTITY_TYPES = new Set(['notes', 'library', 'plot']);

// Room name for a gateway mutation. Singleton rooms are keyed by project id;
// entity rooms by the entity's own ObjectId hex. `projectId` must already be
// resolved (24-hex) by the caller via resolveProjectId.
function roomNameFor(entityType, entityId, projectId) {
  if (SINGLETON_ENTITY_TYPES.has(entityType)) {
    return buildRoomName(entityType, projectId);
  }
  return buildRoomName(entityType, entityId);
}

// Map a gateway entityType/field tuple to the RAG reindex key. Used after
// fallback (non-Yjs) writes — the Yjs path enqueues from roomRegistry
// persistFields, so we only need this for the !isHocuspocusRunning() branch.
function enqueueRagAfterFallback({ entityType, entityId, field }) {
  if (entityType === 'beat') {
    enqueueReindex('beat', String(entityId));
    return;
  }
  if (entityType === 'character') {
    enqueueReindex('character', String(entityId));
    return;
  }
  if (entityType === 'set') {
    enqueueReindex('set', String(entityId));
    return;
  }
  if (entityType === 'notes' && typeof field === 'string') {
    const m = field.match(/^note:([a-f0-9]{24}):text$/);
    if (m) enqueueReindex('director_note', m[1]);
  }
}

// ─── Text-field mutations ──────────────────────────────────────────────────
//
// When Hocuspocus is running (production), text mutations route through the
// y-doc so connected editors see the change live and the server-side store
// hook persists markdown to Mongo.
//
// When Hocuspocus is NOT running (tests, CLI scripts), the gateway falls
// back to writing Mongo directly via the underlying helpers — same end
// result, no live broadcast.

async function readEntityField({ projectId, entityType, entityId, field }) {
  if (entityType === 'beat') {
    const beat = await getBeat(projectId, entityId);
    if (!beat) throw new Error(`Beat not found: ${entityId}`);
    if (field === 'body') return String(beat.body || '');
    if (field === 'name') return String(beat.name || '');
    {
      const m = field.match(/^image:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findImageFile(m[1]);
        if (!file) throw new Error(`Image not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    {
      const m = field.match(/^attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findAttachmentFile(m[1]);
        if (!file) throw new Error(`Attachment not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    throw new Error(`gateway fallback: unknown beat field "${field}"`);
  }
  if (entityType === 'character') {
    const c = await getCharacter(projectId, entityId);
    if (!c) throw new Error(`Character not found: ${entityId}`);
    if (field === 'name') return String(c.name || '');
    if (field === 'hollywood_actor') return String(c.hollywood_actor || '');
    if (field.startsWith('fields.')) {
      const v = c.fields?.[field.slice('fields.'.length)];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    {
      const m = field.match(/^image:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findImageFile(m[1]);
        if (!file) throw new Error(`Image not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    {
      const m = field.match(/^attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findAttachmentFile(m[1]);
        if (!file) throw new Error(`Attachment not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    throw new Error(`gateway fallback: unknown character field "${field}"`);
  }
  if (entityType === 'set') {
    const s = await getSet(projectId, entityId);
    if (!s) throw new Error(`Set not found: ${entityId}`);
    if (field === 'name') return String(s.name || '');
    if (field === 'description') return String(s.description || '');
    {
      const m = field.match(/^image:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findImageFile(m[1]);
        if (!file) throw new Error(`Image not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    {
      const m = field.match(/^attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findAttachmentFile(m[1]);
        if (!file) throw new Error(`Attachment not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    throw new Error(`gateway fallback: unknown set field "${field}"`);
  }
  if (entityType === 'notes' && field.startsWith('note:') && field.endsWith(':text')) {
    const noteId = field.slice('note:'.length, -':text'.length);
    const doc = await getDirectorNotes(projectId);
    const note = (doc.notes || []).find((n) => n._id?.toString?.() === String(noteId));
    if (!note) throw new Error(`Director's note not found: ${noteId}`);
    return String(note.text || '');
  }
  if (entityType === 'plot') {
    const plot = await Plots.getPlot(projectId);
    return plot[field] != null ? String(plot[field]) : '';
  }
  if (entityType === 'dialogs') {
    const m = field.match(/^item:([a-f0-9]{24}):(body|character)$/);
    if (!m) throw new Error(`gateway fallback: unknown dialogs field "${field}"`);
    const d = await mongoGetDialog(projectId, m[1]);
    if (!d) throw new Error(`Dialog not found: ${m[1]}`);
    return String(d[m[2]] || '');
  }
  if (entityType === 'video_prompts') {
    const sm = field.match(/^scene:([a-f0-9]{24}):floor_plan$/);
    if (sm) {
      const s = await mongoGetVideoScene(projectId, sm[1]);
      if (!s) throw new Error(`Video scene not found: ${sm[1]}`);
      return String(s.floor_plan || '');
    }
    const m = field.match(/^item:([a-f0-9]{24}):(title|prompt|start_frame_prompt|end_frame_prompt)$/);
    if (!m) throw new Error(`gateway fallback: unknown video_prompts field "${field}"`);
    const p = await mongoGetVideoPrompt(projectId, m[1]);
    if (!p) throw new Error(`Video prompt not found: ${m[1]}`);
    if (m[2] === 'start_frame_prompt') return String(p.start_frame?.prompt || '');
    if (m[2] === 'end_frame_prompt') return String(p.end_frame?.prompt || '');
    return String(p[m[2]] || '');
  }
  if (entityType === 'library') {
    {
      const m = field.match(/^library:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findImageFile(m[1]);
        if (!file) throw new Error(`Library image not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    {
      const m = field.match(/^library_attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) {
        const file = await findAttachmentFile(m[1]);
        if (!file) throw new Error(`Library attachment not found: ${m[1]}`);
        return String(file.metadata?.[m[2]] || '');
      }
    }
    throw new Error(`gateway fallback: unknown library field "${field}"`);
  }
  throw new Error(`gateway fallback: cannot read ${entityType}/${field}`);
}

async function fallbackTextWrite({ projectId, entityType, entityId, field, op, ...args }) {
  if (entityType === 'beat' && field === 'body') {
    if (op === 'set') return Plots.setBeatBody(projectId, entityId, args.markdown);
    if (op === 'edit') return Plots.editBeatBody(projectId, entityId, args.edits);
    if (op === 'append') return Plots.appendBeatBody(projectId, entityId, args.content);
  }

  if (op === 'edit') {
    const { applyMarkdownEdits } = await import('../util/textWindow.js');
    const current = await readEntityField({ projectId, entityType, entityId, field });
    const result = applyMarkdownEdits(current, args.edits, 'edit_field');
    await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'set', markdown: result.body });
    return {
      edits: result.applied,
      beforeLen: result.beforeLen,
      afterLen: result.afterLen,
      value: result.body,
    };
  }

  if (op === 'append') {
    const current = await readEntityField({ projectId, entityType, entityId, field });
    const addition = String(args.content ?? '').trim();
    if (!addition) throw new Error('No content to append.');
    const sep = current.trim() ? '\n\n' : '';
    const next = `${current}${sep}${addition}`;
    await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'set', markdown: next });
    return { value: next };
  }

  // op === 'set' (or any unrecognized op falls through here)
  if (entityType === 'beat') {
    {
      const m = field.match(/^image:([a-f0-9]{24}):(name|description)$/);
      if (m) return setOwnedImageMeta(m[1], { [m[2]]: args.markdown });
    }
    {
      const m = field.match(/^attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) return setOwnedAttachmentMeta(m[1], { [m[2]]: args.markdown });
    }
    // Scene bible: whole-object read-modify-write via the normalizing helper.
    // Avoids a dotted `$set` through a null scene_bible — the same reason
    // describeBeatRoom.persistFields reassembles the object (roomRegistry.js).
    if (field.startsWith('scene_bible.')) {
      const key = field.slice('scene_bible.'.length);
      const beat = await Plots.getBeat(projectId, entityId);
      return Plots.setBeatSceneBible(projectId, entityId, {
        ...(beat?.scene_bible || {}),
        [key]: args.markdown,
      });
    }
    return Plots.updateBeat(projectId, entityId, { [field]: args.markdown });
  }
  if (entityType === 'character') {
    {
      const m = field.match(/^image:([a-f0-9]{24}):(name|description)$/);
      if (m) return setOwnedImageMeta(m[1], { [m[2]]: args.markdown });
    }
    {
      const m = field.match(/^attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) return setOwnedAttachmentMeta(m[1], { [m[2]]: args.markdown });
    }
    const { updateCharacter } = await import('../mongo/characters.js');
    if (field === 'name' || field === 'hollywood_actor') {
      return updateCharacter(projectId, entityId, { [field]: args.markdown });
    }
    if (field.startsWith('fields.')) {
      return updateCharacter(projectId, entityId, { [field]: args.markdown });
    }
  }
  if (entityType === 'set') {
    {
      const m = field.match(/^image:([a-f0-9]{24}):(name|description)$/);
      if (m) return setOwnedImageMeta(m[1], { [m[2]]: args.markdown });
    }
    {
      const m = field.match(/^attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) return setOwnedAttachmentMeta(m[1], { [m[2]]: args.markdown });
    }
    if (field === 'name' || field === 'description') {
      return mongoUpdateSet(projectId, entityId, { [field]: args.markdown });
    }
    throw new Error(`gateway fallback: unknown set field "${field}"`);
  }
  if (entityType === 'notes' && field.startsWith('note:') && field.endsWith(':text')) {
    const noteId = field.slice('note:'.length, -':text'.length);
    const { editDirectorNote } = await import('../mongo/directorNotes.js');
    return editDirectorNote({ projectId, noteId, text: args.markdown });
  }
  if (entityType === 'plot') {
    return Plots.updatePlot(projectId, { [field]: args.markdown });
  }
  if (entityType === 'dialogs') {
    if (field === 'dialog_notes') {
      return Plots.updateBeat(projectId, entityId, { dialog_notes: args.markdown });
    }
    const m = field.match(/^item:([a-f0-9]{24}):(body|character|direction)$/);
    if (!m) throw new Error(`gateway fallback: unknown dialogs field "${field}"`);
    return mongoUpdateDialog(projectId, m[1], { [m[2]]: args.markdown });
  }
  if (entityType === 'video_prompts') {
    const sm = field.match(/^scene:([a-f0-9]{24}):floor_plan$/);
    if (sm) return mongoUpdateVideoScene(projectId, sm[1], { floor_plan: args.markdown });
    const m = field.match(/^item:([a-f0-9]{24}):(title|prompt|start_frame_prompt|end_frame_prompt)$/);
    if (!m) throw new Error(`gateway fallback: unknown video_prompts field "${field}"`);
    return mongoUpdateVideoPrompt(projectId, m[1], { [m[2]]: args.markdown });
  }
  if (entityType === 'library') {
    {
      const m = field.match(/^library:([a-f0-9]{24}):(name|description)$/);
      if (m) return setLibraryImageMeta(m[1], { [m[2]]: args.markdown });
    }
    {
      const m = field.match(/^library_attachment:([a-f0-9]{24}):(name|description)$/);
      if (m) return setLibraryAttachmentMeta(m[1], { [m[2]]: args.markdown });
    }
    throw new Error(`gateway fallback: unknown library field "${field}"`);
  }
  throw new Error(`gateway fallback not implemented for ${entityType}/${field}`);
}

// A beat body is a screenplay page: a slugline, a character cue, a
// parenthetical and the speech under it each sit on their own line. Markdown
// joins a bare newline inside a paragraph into a space, so every write of a
// beat body — the agent's tools, the SPA's REST calls, the rewrite passes —
// turns those newlines into hard breaks here, at the one place they all pass.
const isBeatBody = (entityType, field) => entityType === 'beat' && field === 'body';

export async function setEntityFieldMarkdown({ projectId, entityType, entityId, field, markdown }) {
  projectId = await resolveProjectId(projectId);
  if (isBeatBody(entityType, field)) markdown = linesToHardBreaks(markdown);
  if (!isHocuspocusRunning()) {
    await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'set', markdown });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return;
  }
  const { setFragmentMarkdown } = await he();
  const roomName = roomNameFor(entityType, entityId, projectId);
  await withDirectDocument(roomName, gatewayEditContext(), (document) => {
    withBotPresence(roomName, field, () => {
      setFragmentMarkdown(document, field, String(markdown ?? ''));
    });
  });
  logger.info(
    `gateway: set ${entityType}/${entityId}/${field} chars=${String(markdown ?? '').length}`,
  );
}

export async function editEntityFieldMarkdown({ projectId, entityType, entityId, field, edits }) {
  projectId = await resolveProjectId(projectId);
  if (isBeatBody(entityType, field) && Array.isArray(edits)) {
    // The stored body carries hard-break marks the caller may not have typed:
    // `find_alt` is the same passage with them, tried when `find` misses.
    edits = edits.map((e) => (e && typeof e.find === 'string' && typeof e.replace === 'string'
      ? { ...e, find_alt: linesToHardBreaks(e.find, { trim: false }), replace: linesToHardBreaks(e.replace, { trim: false }) }
      : e));
  }
  if (!isHocuspocusRunning()) {
    const result = await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'edit', edits });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return {
      applied: (result?.edits || edits).map((e) => ({
        find_chars: e.find_chars ?? (e.find?.length || 0),
        replace_chars: e.replace_chars ?? (e.replace?.length || 0),
      })),
      beforeLen: result?.beforeLen ?? 0,
      afterLen: result?.afterLen ?? 0,
      body: result?.beat?.body ?? result?.value ?? '',
    };
  }
  const { editFragmentMarkdown } = await he();
  const roomName = roomNameFor(entityType, entityId, projectId);
  let outcome;
  await withDirectDocument(roomName, gatewayEditContext(), (document) => {
    withBotPresence(roomName, field, () => {
      outcome = editFragmentMarkdown(document, field, edits);
    });
  });
  logger.info(
    `gateway: edit ${entityType}/${entityId}/${field} edits=${edits.length} ` +
      `before=${outcome.beforeLen} after=${outcome.afterLen}`,
  );
  return outcome;
}

export async function appendEntityFieldMarkdown({ projectId, entityType, entityId, field, content }) {
  projectId = await resolveProjectId(projectId);
  if (isBeatBody(entityType, field)) content = linesToHardBreaks(content);
  if (!isHocuspocusRunning()) {
    const result = await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'append', content });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return result?.body ?? '';
  }
  const { appendToFragmentMarkdown } = await he();
  const roomName = roomNameFor(entityType, entityId, projectId);
  let next;
  await withDirectDocument(roomName, gatewayEditContext(), (document) => {
    withBotPresence(roomName, field, () => {
      next = appendToFragmentMarkdown(document, field, content);
    });
  });
  logger.info(
    `gateway: append ${entityType}/${entityId}/${field} added=${String(content ?? '').length}`,
  );
  return next;
}

// Conveniences for specific entity flavors used by handlers ----------------

export async function setBeatBodyViaGateway(projectId, beatId, body) {
  return setEntityFieldMarkdown({
    projectId,
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    markdown: body,
  });
}

export async function editBeatBodyViaGateway(projectId, beatId, edits) {
  return editEntityFieldMarkdown({
    projectId,
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    edits,
  });
}

export async function appendBeatBodyViaGateway(projectId, beatId, content) {
  return appendEntityFieldMarkdown({
    projectId,
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    content,
  });
}

// updateBeat may include text fields (name/body) and order/characters;
// route text fields through the gateway and the rest through Mongo.
export async function updateBeatViaGateway(projectId, identifier, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_beat: \`patch\` must be an object like {body: "..."}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }. Wrap your fields in {patch: {body: "..."}} (or name/order/characters).`,
    );
  }
  const isRecognizedKey = (k) =>
    k === 'name' ||
    k === 'body' ||
    k === 'order' ||
    k === 'characters' ||
    k === 'sets' ||
    k === 'wardrobe_overrides';
  if (!Object.keys(patch).some((k) => isRecognizedKey(k) && patch[k] !== undefined)) {
    throw new Error(
      `update_beat: \`patch\` has no recognized fields. Expected one of: name, body, order, characters, sets, wardrobe_overrides. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const beat = await getBeat(projectId, identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const beatId = beat._id.toString();
  if (patch.name !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'beat',
      entityId: beatId,
      field: 'name',
      markdown: patch.name,
    });
  }
  if (patch.body !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'beat',
      entityId: beatId,
      field: 'body',
      markdown: patch.body,
    });
  }
  // order, characters, and sets are non-text → hit Mongo directly.
  const onlyDiscrete = {};
  if (patch.order !== undefined) onlyDiscrete.order = patch.order;
  if (Array.isArray(patch.characters)) onlyDiscrete.characters = patch.characters;
  if (Array.isArray(patch.sets)) onlyDiscrete.sets = patch.sets;
  if (patch.wardrobe_overrides && typeof patch.wardrobe_overrides === 'object') onlyDiscrete.wardrobe_overrides = patch.wardrobe_overrides;
  if (Object.keys(onlyDiscrete).length) {
    const { updateBeat: mongoUpdateBeat } = await import('../mongo/plots.js');
    await mongoUpdateBeat(projectId, beatId, onlyDiscrete);
    broadcastFieldsUpdated(buildRoomName('beat', beatId), {
      changed: Object.keys(onlyDiscrete),
    });
    if (onlyDiscrete.order !== undefined) await broadcastBeatsChanged(projectId);
  }
  const after = await getBeat(projectId, beatId);
  // Attribute a cast change to the in-scope web user (chat agent / AI feature).
  // Bot/Discord edits have no editor scope and stay silent. maybeAnnounceCast
  // is fire-and-forget, so we don't await it.
  const editor = currentEditor();
  if (Array.isArray(patch.characters) && editor) {
    const { added, removed } = diffCast(beat.characters || [], after.characters || []);
    if (added.length || removed.length) {
      const proj = await getProjectById(projectId).catch(() => null);
      maybeAnnounceCast({
        projectTitle: proj?.title ?? null,
        beat: after,
        editor,
        added,
        removed,
      });
    }
  }
  // A single-beat position move (update_beat with `order`) announces like the
  // bulk reorder path — only when the position actually changed.
  if (patch.order !== undefined && editor && after.order !== beat.order) {
    const pid = await resolveProjectId(projectId);
    announceBeatLifecycle({ projectId: pid, beat: after, editor, verb: 'moved' });
  }
  return after;
}

export async function updateCharacterViaGateway(projectId, identifier, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_character: \`patch\` must be an object like {name: "..."} or {fields: {...}}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }.`,
    );
  }
  const recognized = Object.keys(patch).some(
    (k) =>
      k === 'name' ||
      k === 'fields' ||
      k.startsWith('fields.') ||
      k === 'hollywood_actor' ||
      k === 'unset',
  );
  if (!recognized) {
    throw new Error(
      `update_character: \`patch\` has no recognized fields. Expected name, fields, fields.<key>, hollywood_actor, or unset. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const cid = c._id.toString();
  // Text fields (name, hollywood_actor, fields.*) flow through the y-doc;
  // `unset` is the only non-text patch op.
  const textOps = [];
  let unset;
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'name' || k === 'hollywood_actor') {
      textOps.push({ field: k, markdown: v });
    } else if (k === 'fields' && v && typeof v === 'object') {
      for (const [fk, fv] of Object.entries(v)) {
        textOps.push({ field: `fields.${fk}`, markdown: fv });
      }
    } else if (k.startsWith('fields.')) {
      textOps.push({ field: k, markdown: v });
    } else if (k === 'unset') {
      unset = v;
    }
  }
  for (const { field, markdown } of textOps) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'character',
      entityId: cid,
      field,
      markdown,
    });
  }
  if (unset) {
    await mongoUpdateCharacter(projectId, cid, { unset });
    broadcastFieldsUpdated(buildRoomName('character', cid), {
      changed: unset.map((u) => `-fields.${u}`),
    });
  }
  return getCharacter(projectId, cid);
}

export async function updateSetViaGateway(projectId, identifier, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_set: \`patch\` must be an object like {name: "..."} or {description: "..."}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }.`,
    );
  }
  const recognized = Object.keys(patch).some((k) => k === 'name' || k === 'description');
  if (!recognized) {
    throw new Error(
      `update_set: \`patch\` has no recognized fields. Expected name or description. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const sid = s._id.toString();
  for (const field of ['name', 'description']) {
    if (patch[field] === undefined) continue;
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'set',
      entityId: sid,
      field,
      markdown: patch[field],
    });
  }
  return getSet(projectId, sid);
}

export async function editSetFieldViaGateway({ projectId, identifier, field, edits }) {
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  return editEntityFieldMarkdown({
    projectId,
    entityType: 'set',
    entityId: s._id.toString(),
    field,
    edits,
  });
}

export async function editDirectorNoteViaGateway({ projectId, noteId, text }) {
  projectId = await resolveProjectId(projectId);
  return setEntityFieldMarkdown({
    projectId,
    entityType: 'notes',
    entityId: 'notes',
    field: `note:${String(noteId)}:text`,
    markdown: text,
  });
}

export async function editDirectorNoteTextViaGateway({ projectId, noteId, edits }) {
  projectId = await resolveProjectId(projectId);
  return editEntityFieldMarkdown({
    projectId,
    entityType: 'notes',
    entityId: 'notes',
    field: `note:${String(noteId)}:text`,
    edits,
  });
}

export async function editCharacterFieldViaGateway({ projectId, identifier, field, edits }) {
  const c = await getCharacter(projectId, identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  return editEntityFieldMarkdown({
    projectId,
    entityType: 'character',
    entityId: c._id.toString(),
    field,
    edits,
  });
}

export async function addDirectorNoteViaGateway({ projectId, text, position }) {
  projectId = await resolveProjectId(projectId);
  // Add the note in Mongo (it gets a fresh _id), then ping the room so the
  // /notes page renders the new editor for its text fragment. The fragment
  // itself will be seeded from the just-written `text` on first connection.
  const note = await mongoAddDirectorNote({ projectId, text, position });
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: ['notes'],
    added_note_id: note._id.toString(),
  });
  enqueueReindex('director_note', note._id.toString());
  return note;
}

export async function removeDirectorNoteViaGateway({ projectId, noteId }) {
  projectId = await resolveProjectId(projectId);
  await mongoRemoveDirectorNote({ projectId, noteId });
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: ['notes'],
    removed_note_id: String(noteId),
  });
  // Immediate delete so stale chunks don't linger in retrieval.
  deleteEntity('director_note', String(noteId)).catch(() => {});
}

// ─── Non-text mutations ────────────────────────────────────────────────────

export async function addBeatImageViaGateway({ projectId, beatId, imageMeta, setAsMain }) {
  const result = await pushBeatImage(projectId, String(beatId), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function removeBeatImageViaGateway({ projectId, beatId, imageId }) {
  const result = await pullBeatImage(projectId, String(beatId), imageId);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function setBeatMainImageViaGateway({ projectId, beatId, imageId }) {
  const result = await setBeatMainImage(projectId, String(beatId), imageId);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['main_image_id'],
  });
  return result;
}

export async function addBeatAttachmentViaGateway({ projectId, beatId, attachmentMeta }) {
  const result = await pushBeatAttachment(projectId, String(beatId), attachmentMeta);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['attachments'],
  });
  return result;
}

export async function removeBeatAttachmentViaGateway({ projectId, beatId, attachmentId }) {
  const result = await pullBeatAttachment(projectId, String(beatId), attachmentId);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['attachments'],
  });
  return result;
}

export async function addCharacterImageViaGateway({ projectId, character, imageMeta, setAsMain }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await pushCharacterImage(projectId, c._id.toString(), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function setCharacterMainImageViaGateway({ projectId, character, imageId }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await setMainCharacterImage({ projectId, character: c._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['main_image_id'],
  });
  return result;
}

// The wardrobe plate (src/web/wardrobe.js). `imageId: null` clears it.
export async function setCharacterWardrobeImageViaGateway({ projectId, character, imageId }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await setCharacterWardrobeImage({ projectId, character: c._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['wardrobe_image_id'],
  });
  return result;
}

export async function removeCharacterImageViaGateway({ projectId, character, imageId }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await removeCharacterImage({ projectId, character: c._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['images', 'main_image_id', 'wardrobe_image_id'],
  });
  return result;
}

export async function addCharacterAttachmentViaGateway({ projectId, character, attachmentMeta }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await pushCharacterAttachment(projectId, c._id.toString(), attachmentMeta);
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['attachments'],
  });
  return result;
}

export async function addSetImageViaGateway({ projectId, set, imageMeta, setAsMain }) {
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const result = await pushSetImage(projectId, s._id.toString(), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('set', s._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function setSetMainImageViaGateway({ projectId, set, imageId }) {
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const result = await setMainSetImage({ projectId, set: s._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('set', s._id.toString()), {
    changed: ['main_image_id'],
  });
  return result;
}

export async function removeSetImageViaGateway({ projectId, set, imageId }) {
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const result = await removeSetImage({ projectId, set: s._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('set', s._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function addSetAttachmentViaGateway({ projectId, set, attachmentMeta }) {
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const result = await pushSetAttachment(projectId, s._id.toString(), attachmentMeta);
  broadcastFieldsUpdated(buildRoomName('set', s._id.toString()), {
    changed: ['attachments'],
  });
  return result;
}

export async function removeSetAttachmentViaGateway({ projectId, set, attachmentId }) {
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const result = await pullSetAttachment(projectId, s._id.toString(), attachmentId);
  broadcastFieldsUpdated(buildRoomName('set', s._id.toString()), {
    changed: ['attachments'],
  });
  return result;
}

// ── Artwork gateway (host-agnostic: character or beat) ───────────────────
// All helpers broadcast `fields_updated` on the host's room
// (character:<id> or beat:<id>) with `changed: ['artworks']`. The SPA's
// CollabSurface listens for this and re-fetches the host doc, so the
// artwork gallery updates without polling. GridFS cleanup of orphaned
// images (e.g. the prior result after an edit) is handled here so callers
// don't have to think about it.

function artworkRoomName(hostType, hostId) {
  return buildRoomName(hostType, String(hostId));
}

async function tryDeleteImage(imageId, ctx) {
  if (!imageId) return;
  try {
    await deleteImage(imageId);
  } catch (e) {
    logger.warn(`gateway: delete ${ctx} image ${imageId} failed: ${e.message}`);
  }
}

export async function createPendingArtworkViaGateway({
  projectId,
  hostType,
  hostId,
  prompt,
  name = '',
  model,
  referenceImageIds = [],
  jobId = null,
}) {
  const result = await mongoCreatePendingArtwork({
    projectId,
    hostType,
    hostId,
    prompt,
    name,
    model,
    referenceImageIds,
    jobId,
  });
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: ['artworks'],
  });
  return result;
}

// Import an existing GridFS image as a brand-new "done" artwork on the host.
// If the source image is owned by a different entity (or sits in the library),
// its bytes are copied to a fresh GridFS file owned by the host so the
// artwork's result_image_id matches the one-owner-per-file invariant the
// gallery / delete paths rely on. When the source is already owned by this
// host, the existing id is reused — no copy.
export async function createArtworkFromImageViaGateway({
  projectId,
  hostType,
  hostId,
  imageId,
  name = '',
}) {
  const src = await findImageFile(imageId);
  if (!src) {
    const e = new Error(`source image not found: ${imageId}`);
    e.status = 404;
    throw e;
  }
  const ownerType = src.metadata?.owner_type || null;
  const ownerId = src.metadata?.owner_id || null;
  const hostIdStr = String(hostId);
  const sameOwner =
    ownerType === hostType &&
    ownerId &&
    String(ownerId) === hostIdStr;
  let resultImageId;
  if (sameOwner) {
    resultImageId = src._id;
  } else {
    const copy = await copyImageToNewOwner({
      projectId,
      imageId,
      ownerType: hostType,
      ownerId: hostIdStr,
      filenameBase: `${hostType}-${hostIdStr}-artwork-import`,
    });
    resultImageId = copy._id;
  }
  const result = await mongoAppendDoneArtwork({
    projectId,
    hostType,
    hostId,
    resultImageId,
    name,
  });
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: ['artworks'],
  });
  return result;
}

export async function patchArtworkViaGateway({ projectId, hostType, hostId, artworkId, patch }) {
  const result = await mongoPatchArtwork({ projectId, hostType, hostId, artworkId, patch });
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: ['artworks'],
  });
  return result;
}

export async function setArtworkStatusViaGateway({
  projectId,
  hostType,
  hostId,
  artworkId,
  status,
  errorMessage = null,
}) {
  const result = await mongoSetArtworkStatus({
    projectId,
    hostType,
    hostId,
    artworkId,
    status,
    errorMessage,
  });
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: ['artworks'],
  });
  return result;
}

function artworkChangedFields(result) {
  const out = ['artworks'];
  if (result.mainImageIdChange?.changed) out.push('main_image_id');
  if (result.wardrobeImageIdChange?.changed) out.push('wardrobe_image_id');
  return out;
}

export async function setArtworkResultViaGateway({
  projectId,
  hostType,
  hostId,
  artworkId,
  resultImageId,
  rotateToPrevious = false,
}) {
  const result = await mongoSetArtworkResult({
    projectId,
    hostType,
    hostId,
    artworkId,
    resultImageId,
    rotateToPrevious,
  });
  await tryDeleteImage(result.orphanedImageId, 'orphaned artwork');
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: artworkChangedFields(result),
  });
  return result;
}

export async function undoArtworkEditViaGateway({ projectId, hostType, hostId, artworkId }) {
  const result = await mongoUndoArtworkEdit({ projectId, hostType, hostId, artworkId });
  await tryDeleteImage(result.orphanedImageId, 'undone artwork');
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: artworkChangedFields(result),
  });
  return result;
}

export async function removeArtworkViaGateway({ projectId, hostType, hostId, artworkId }) {
  const result = await mongoRemoveArtwork({ projectId, hostType, hostId, artworkId });
  for (const id of result.removed_image_ids) {
    await tryDeleteImage(id, 'removed artwork');
  }
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: artworkChangedFields(result),
  });
  return result;
}

export async function removeCharacterAttachmentViaGateway({ projectId, character, attachmentId }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await pullCharacterAttachment(projectId, c._id.toString(), attachmentId);
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['attachments'],
  });
  return result;
}

// Replace a beat's image with a new one at the same slot position. Caller
// has already uploaded `newImageMeta` to GridFS; this helper swaps the meta
// inside beat.images[], updates main_image_id when applicable, deletes the
// old GridFS bytes, then broadcasts to the room.
export async function replaceBeatImageViaGateway({ projectId, beatId, oldImageId, newImageMeta }) {
  const result = await replaceBeatImage(projectId, String(beatId), oldImageId, newImageMeta);
  try {
    await deleteImage(oldImageId);
  } catch (e) {
    logger.warn(`gateway: delete replaced beat image ${oldImageId} failed: ${e.message}`);
  }
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function replaceCharacterImageViaGateway({ projectId, character, oldImageId, newImageMeta }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const cid = c._id.toString();
  const result = await replaceCharacterImage(projectId, cid, oldImageId, newImageMeta);
  try {
    await deleteImage(oldImageId);
  } catch (e) {
    logger.warn(`gateway: delete replaced character image ${oldImageId} failed: ${e.message}`);
  }
  broadcastFieldsUpdated(buildRoomName('character', cid), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

// Move an entity-owned image into the library: detach from the owner's
// images[] array, clear the GridFS owner metadata, and broadcast both rooms.
// The GridFS bytes are kept (no delete) — the file becomes a library image.
// Broadcast a ping to whichever room owned this GridFS image before it was
// reassigned, so users looking at the prior owner see it disappear without a
// refetch. `movedFrom` comes from detachImageFromCurrentOwner — null means
// the image was in the library.
function broadcastPriorImageOwner(projectId, movedFrom) {
  if (!movedFrom) {
    broadcastFieldsUpdated(buildRoomName('library', projectId), { changed: ['library_images'] });
    return;
  }
  if (movedFrom.prior_owner_type === 'beat') {
    broadcastFieldsUpdated(
      buildRoomName('beat', String(movedFrom.prior_owner_id)),
      { changed: ['images', 'main_image_id'] },
    );
  } else if (movedFrom.prior_owner_type === 'character') {
    broadcastFieldsUpdated(
      buildRoomName('character', String(movedFrom.prior_owner_id)),
      { changed: ['images', 'main_image_id'] },
    );
  } else if (movedFrom.prior_owner_type === 'director_note') {
    broadcastFieldsUpdated(buildRoomName('notes', projectId), {
      changed: [
        `note:${movedFrom.prior_owner_id}:images`,
        `note:${movedFrom.prior_owner_id}:main_image_id`,
      ],
      note_id: String(movedFrom.prior_owner_id),
    });
  }
}

function broadcastPriorAttachmentOwner(projectId, movedFrom) {
  if (!movedFrom) {
    broadcastFieldsUpdated(buildRoomName('library', projectId), { changed: ['library_attachments'] });
    return;
  }
  if (movedFrom.prior_owner_type === 'beat') {
    broadcastFieldsUpdated(
      buildRoomName('beat', String(movedFrom.prior_owner_id)),
      { changed: ['attachments'] },
    );
  } else if (movedFrom.prior_owner_type === 'character') {
    broadcastFieldsUpdated(
      buildRoomName('character', String(movedFrom.prior_owner_id)),
      { changed: ['attachments'] },
    );
  } else if (movedFrom.prior_owner_type === 'director_note') {
    broadcastFieldsUpdated(buildRoomName('notes', projectId), {
      changed: [`note:${movedFrom.prior_owner_id}:attachments`],
      note_id: String(movedFrom.prior_owner_id),
    });
  }
}

// Attach an already-uploaded GridFS image to a beat's gallery. The image's
// current owner is detached first (library or another entity), then ownership
// is reassigned and beat.images[] gets a new entry. Both rooms broadcast.
export async function replaceSetImageViaGateway({ projectId, set, oldImageId, newImageMeta }) {
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const sid = s._id.toString();
  const result = await replaceSetImage(projectId, sid, oldImageId, newImageMeta);
  try {
    await deleteImage(oldImageId);
  } catch (e) {
    logger.warn(`gateway: delete replaced set image ${oldImageId} failed: ${e.message}`);
  }
  broadcastFieldsUpdated(buildRoomName('set', sid), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function attachExistingImageToSetViaGateway({
  projectId,
  set,
  imageId,
  setAsMain = false,
}) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);
  if (
    file.metadata?.owner_type === 'set' &&
    file.metadata?.owner_id &&
    file.metadata.owner_id.equals(s._id)
  ) {
    return { already_attached: true, set: s.name };
  }
  const movedFrom = await detachImageFromCurrentOwner(file);
  await setImageOwner(imageId, {
    ownerType: 'set',
    ownerId: s._id,
  });
  const meta = {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType || file.metadata?.content_type || null,
    size: file.length,
    source: file.metadata?.source || 'library',
    prompt: file.metadata?.prompt || null,
    generated_by: file.metadata?.generated_by || null,
    uploaded_at: file.uploadDate,
  };
  const result = await pushSetImage(projectId, s._id.toString(), meta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('set', s._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  broadcastPriorImageOwner(projectId, movedFrom);
  return result;
}

export async function moveSetImageToLibraryViaGateway({ projectId, set, imageId }) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const sid = s._id.toString();
  const result = await pullSetImage(projectId, sid, imageId);
  await setImageOwner(imageId, { ownerType: null, ownerId: null });
  broadcastFieldsUpdated(buildRoomName('set', sid), {
    changed: ['images', 'main_image_id'],
  });
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    added_image_id: String(imageId),
  });
  return result;
}

export async function attachExistingAttachmentToSetViaGateway({
  projectId,
  set,
  attachmentId,
}) {
  projectId = await resolveProjectId(projectId);
  const s = await getSet(projectId, set);
  if (!s) throw new Error(`Set not found: ${set}`);
  const { attachExistingAttachmentToSet } = await import('../mongo/attachments.js');
  const result = await attachExistingAttachmentToSet({
    projectId,
    set: s._id.toString(),
    attachmentId,
  });
  if (!result?.already_attached) {
    broadcastFieldsUpdated(buildRoomName('set', s._id.toString()), {
      changed: ['attachments'],
    });
    broadcastPriorAttachmentOwner(projectId, result?.moved_from);
  }
  return result;
}

export async function attachExistingImageToBeatViaGateway({
  projectId,
  beatId,
  imageId,
  setAsMain = false,
}) {
  projectId = await resolveProjectId(projectId);
  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);
  const targetBeat = await getBeat(projectId, String(beatId));
  if (!targetBeat) throw new Error(`Beat not found: ${beatId}`);
  if (
    file.metadata?.owner_type === 'beat' &&
    file.metadata?.owner_id &&
    file.metadata.owner_id.equals(targetBeat._id)
  ) {
    return { already_attached: true, beat: targetBeat };
  }
  const movedFrom = await detachImageFromCurrentOwner(file);
  await setImageOwner(imageId, {
    ownerType: 'beat',
    ownerId: targetBeat._id,
  });
  const meta = {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType || file.metadata?.content_type || null,
    size: file.length,
    source: file.metadata?.source || 'library',
    prompt: file.metadata?.prompt || null,
    generated_by: file.metadata?.generated_by || null,
    uploaded_at: file.uploadDate,
  };
  const result = await pushBeatImage(
    projectId,
    targetBeat._id.toString(),
    meta,
    !!setAsMain,
  );
  broadcastFieldsUpdated(
    buildRoomName('beat', targetBeat._id.toString()),
    { changed: ['images', 'main_image_id'] },
  );
  broadcastPriorImageOwner(projectId, movedFrom);
  return result;
}

export async function attachExistingImageToCharacterViaGateway({
  projectId,
  character,
  imageId,
  setAsMain = false,
}) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);
  if (
    file.metadata?.owner_type === 'character' &&
    file.metadata?.owner_id &&
    file.metadata.owner_id.equals(c._id)
  ) {
    return { already_attached: true, character: c.name };
  }
  const movedFrom = await detachImageFromCurrentOwner(file);
  await setImageOwner(imageId, {
    ownerType: 'character',
    ownerId: c._id,
  });
  const meta = {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType || file.metadata?.content_type || null,
    size: file.length,
    source: file.metadata?.source || 'library',
    prompt: file.metadata?.prompt || null,
    generated_by: file.metadata?.generated_by || null,
    uploaded_at: file.uploadDate,
  };
  const result = await pushCharacterImage(
    projectId,
    c._id.toString(),
    meta,
    !!setAsMain,
  );
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  broadcastPriorImageOwner(projectId, movedFrom);
  return result;
}

export async function attachExistingImageToDirectorNoteViaGateway({
  projectId,
  noteId,
  imageId,
  setAsMain = false,
}) {
  projectId = await resolveProjectId(projectId);
  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);
  const { notes = [] } = (await getDirectorNotes(projectId)) || {};
  const target = notes.find((n) => n._id?.toString() === String(noteId));
  if (!target) throw new Error(`Director note not found: ${noteId}`);
  if (
    file.metadata?.owner_type === 'director_note' &&
    file.metadata?.owner_id &&
    file.metadata.owner_id.equals(target._id)
  ) {
    return { already_attached: true };
  }
  const movedFrom = await detachImageFromCurrentOwner(file);
  await setImageOwner(imageId, {
    ownerType: 'director_note',
    ownerId: target._id,
  });
  const meta = {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType || file.metadata?.content_type || null,
    size: file.length,
    source: file.metadata?.source || 'library',
    prompt: file.metadata?.prompt || null,
    generated_by: file.metadata?.generated_by || null,
    uploaded_at: file.uploadDate,
  };
  const result = await pushDirectorNoteImage(
    projectId,
    target._id.toString(),
    meta,
    !!setAsMain,
  );
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  broadcastPriorImageOwner(projectId, movedFrom);
  return result;
}

export async function attachExistingAttachmentToBeatViaGateway({
  projectId,
  beatId,
  attachmentId,
}) {
  projectId = await resolveProjectId(projectId);
  const result = await attachExistingAttachmentToBeat({
    projectId,
    beat: String(beatId),
    attachmentId,
  });
  if (!result?.already_attached) {
    broadcastFieldsUpdated(
      buildRoomName('beat', String(result?.beat?._id || beatId)),
      { changed: ['attachments'] },
    );
    broadcastPriorAttachmentOwner(projectId, result?.moved_from);
  }
  return result;
}

export async function attachExistingAttachmentToCharacterViaGateway({
  projectId,
  character,
  attachmentId,
}) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await attachExistingAttachmentToCharacter({
    projectId,
    character: c._id.toString(),
    attachmentId,
  });
  if (!result?.already_attached) {
    broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
      changed: ['attachments'],
    });
    broadcastPriorAttachmentOwner(projectId, result?.moved_from);
  }
  return result;
}

export async function attachExistingAttachmentToDirectorNoteViaGateway({
  projectId,
  noteId,
  attachmentId,
}) {
  projectId = await resolveProjectId(projectId);
  const result = await attachExistingAttachmentToDirectorNote({
    projectId,
    noteId: String(noteId),
    attachmentId,
  });
  if (!result?.already_attached) {
    broadcastFieldsUpdated(buildRoomName('notes', projectId), {
      changed: [`note:${noteId}:attachments`],
      note_id: String(noteId),
    });
    broadcastPriorAttachmentOwner(projectId, result?.moved_from);
  }
  return result;
}

export async function moveBeatImageToLibraryViaGateway({ projectId, beatId, imageId }) {
  projectId = await resolveProjectId(projectId);
  const result = await pullBeatImage(projectId, String(beatId), imageId);
  await setImageOwner(imageId, { ownerType: null, ownerId: null });
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    added_image_id: String(imageId),
  });
  return result;
}

export async function moveCharacterImageToLibraryViaGateway({ projectId, character, imageId }) {
  projectId = await resolveProjectId(projectId);
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const cid = c._id.toString();
  const result = await pullCharacterImage(projectId, cid, imageId);
  await setImageOwner(imageId, { ownerType: null, ownerId: null });
  broadcastFieldsUpdated(buildRoomName('character', cid), {
    changed: ['images', 'main_image_id'],
  });
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    added_image_id: String(imageId),
  });
  return result;
}

export async function moveDirectorNoteImageToLibraryViaGateway({ projectId, noteId, imageId }) {
  projectId = await resolveProjectId(projectId);
  const result = await pullDirectorNoteImage(projectId, String(noteId), imageId);
  await setImageOwner(imageId, { ownerType: null, ownerId: null });
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    added_image_id: String(imageId),
  });
  return result;
}

export async function addDirectorNoteImageViaGateway({ projectId, noteId, imageMeta, setAsMain }) {
  projectId = await resolveProjectId(projectId);
  const result = await pushDirectorNoteImage(projectId, String(noteId), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  return result;
}

export async function removeDirectorNoteImageViaGateway({ projectId, noteId, imageId }) {
  projectId = await resolveProjectId(projectId);
  const result = await pullDirectorNoteImage(projectId, String(noteId), imageId);
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  return result;
}

export async function setDirectorNoteMainImageViaGateway({ projectId, noteId, imageId }) {
  projectId = await resolveProjectId(projectId);
  const result = await setDirectorNoteMainImage(projectId, String(noteId), imageId);
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: [`note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  return result;
}

export async function addDirectorNoteAttachmentViaGateway({ projectId, noteId, attachmentMeta }) {
  projectId = await resolveProjectId(projectId);
  const result = await pushDirectorNoteAttachment(projectId, String(noteId), attachmentMeta);
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: [`note:${noteId}:attachments`],
    note_id: String(noteId),
  });
  return result;
}

export async function removeDirectorNoteAttachmentViaGateway({ projectId, noteId, attachmentId }) {
  projectId = await resolveProjectId(projectId);
  const result = await pullDirectorNoteAttachment(projectId, String(noteId), attachmentId);
  broadcastFieldsUpdated(buildRoomName('notes', projectId), {
    changed: [`note:${noteId}:attachments`],
    note_id: String(noteId),
  });
  return result;
}

// The Prompts tab's assembled beat video (beats.$.prompts_video_*, joined cut
// clips; src/web/cutAssemble.js). Stored apart from the legacy video_*
// so neither tab overwrites the other's MP4. Same contract as
// setBeatVideoViaGateway; pings the beat's video_prompts room instead.
export async function setBeatPromptsVideoViaGateway({ projectId, beatId, fileId = null, durationSeconds = null }) {
  const before = await Plots.getBeat(projectId, beatId);
  if (!before) throw new Error(`Beat not found: ${beatId}`);
  const oldId = before.prompts_video_file_id ? String(before.prompts_video_file_id) : null;
  const beat = await Plots.setBeatPromptsVideo(projectId, before._id, { fileId, durationSeconds });
  if (oldId && oldId !== (fileId == null ? null : String(fileId))) {
    try {
      await deleteAttachments([oldId]);
    } catch (e) {
      logger.warn(`gateway: previous prompts beat video ${oldId} cleanup failed: ${e.message}`);
    }
  }
  broadcastFieldsUpdated(buildRoomName('video_prompts', String(before._id)), {
    changed: ['beat_video'],
    beat_id: String(before._id),
  });
  return beat;
}

// A scene's assembled MP4 (video_scenes.video_*). fileId=null discards; the
// previous file is deleted best-effort and the beat's video_prompts room pinged.
export async function setVideoSceneVideoViaGateway({ projectId, sceneId, fileId = null, durationSeconds = null }) {
  const s = await mongoGetVideoScene(projectId, sceneId);
  if (!s) throw new Error(`Video scene not found: ${sceneId}`);
  const oldId = s.video_file_id ? String(s.video_file_id) : null;
  const updated = await mongoSetVideoSceneVideo(s._id, { fileId, durationSeconds });
  if (oldId && oldId !== (fileId == null ? null : String(fileId))) {
    try {
      await deleteAttachments([oldId]);
    } catch (e) {
      logger.warn(`gateway: previous scene video ${oldId} cleanup failed: ${e.message}`);
    }
  }
  broadcastFieldsUpdated(buildRoomName('video_prompts', s.beat_id.toString()), {
    changed: ['scene_video'],
    video_scene_id: s._id.toString(),
  });
  return updated;
}

// Assembled MP4s go stale when the cut SET changes — a cut or scene deleted or
// reordered, the beat wiped. Re-plan and delete
// clear the beat video, a single re-render does not. Clears the beat's
// Prompts-tab MP4 and, unless beatOnly, the given scene's MP4 (sceneId) or
// every scene's. Best-effort: a cleanup failure never fails the caller.
export async function clearAssembledVideosForBeat(projectId, beatId, { sceneId = null, beatOnly = false } = {}) {
  const bid = String(beatId);
  try {
    const beat = await Plots.getBeat(projectId, bid);
    if (beat?.prompts_video_file_id) {
      await setBeatPromptsVideoViaGateway({ projectId, beatId: beat._id, fileId: null });
    }
  } catch (e) {
    logger.warn(`gateway: clear prompts beat video for ${bid} failed: ${e.message}`);
  }
  if (beatOnly) return;
  let targets = [];
  try {
    if (sceneId) {
      const s = await mongoGetVideoScene(projectId, sceneId);
      if (s) targets = [s];
    } else {
      targets = await listVideoScenes({ projectId, beatId: bid });
    }
  } catch (e) {
    logger.warn(`gateway: list scenes for video clear failed: ${e.message}`);
  }
  for (const s of targets) {
    if (!s?.video_file_id) continue;
    try {
      await setVideoSceneVideoViaGateway({ projectId, sceneId: s._id, fileId: null });
    } catch (e) {
      logger.warn(`gateway: clear scene video ${s._id} failed: ${e.message}`);
    }
  }
}

// ─── Dialogs ──────────────────────────────────────────────────────────────
//
// Dialogs live in their own top-level collection but share one y-doc per
// beat (room: "dialogs:<beatId>") with three fragments per item:
// "item:<dialogId>:body", "item:<dialogId>:character", and
// "item:<dialogId>:direction" (the voice-actor performance note). Mutations
// that change room composition (create / delete / reorder) broadcast a
// `fields_updated` ping to the room so the SPA refetches.

// Seed a new row's text fragments into its beat room BEFORE the Mongo row is
// inserted (the caller pre-generates the row id). Seeding after the insert left
// a window where a store tick saw the row with empty fragments and wrote ''
// over the text the row was created with; the seed restored it only if a
// later tick ran and the two persists landed in order. The store hook skips
// fragments whose row does not exist yet, and once the row lands its values
// already equal the fragments. Without Hocuspocus the Mongo row carries the
// text itself, so there is nothing to seed.
async function seedNewRowFragments({ projectId, entityType, beatId, fragments, label }) {
  if (!isHocuspocusRunning()) return;
  for (const [field, text] of fragments) {
    try {
      await setEntityFieldMarkdown({ projectId, entityType, entityId: String(beatId), field, markdown: text });
    } catch (e) {
      logger.warn(`${label}: seed ${field} failed: ${e.message}`);
    }
  }
}

// The seedFragments entries for `allowed` fields. The seed text is what the
// new row is created with, so Mongo and the y-doc start out identical.
function textSeeds(seedFragments, allowed) {
  return Object.fromEntries(Object.entries(seedFragments || {}).filter(([field]) => allowed.has(field)));
}

function dialogItemField(dialogId, field) {
  return `item:${dialogId}:${field}`;
}

const DIALOG_TEXT_FIELDS = new Set(['body', 'character', 'direction']);

export async function setDialogTextFieldViaGateway({ projectId, dialogId, field, text }) {
  if (!DIALOG_TEXT_FIELDS.has(field)) {
    throw new Error(`unknown dialog field: ${field}`);
  }
  const d = await mongoGetDialog(projectId, dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  await setEntityFieldMarkdown({
    projectId,
    entityType: 'dialogs',
    entityId: d.beat_id.toString(),
    field: dialogItemField(d._id.toString(), field),
    markdown: text,
  });
  // The body field is rendered through a CollabField on the SPA, so y-doc
  // sync is enough. The character field is rendered through a non-collab
  // <CharacterSelect>, so we need a stateless ping for connected SPAs to
  // re-fetch the row when bot tools (or LLM batch edits) change it.
  if (field === 'character') {
    broadcastFieldsUpdated(buildRoomName('dialogs', d.beat_id.toString()), {
      changed: ['character'],
      dialog_id: d._id.toString(),
    });
  }
}

// Set a dialog's `character` field. If the supplied name matches a roster
// character (case-insensitive on stripMarkdown), the canonical roster spelling
// is stored. Otherwise the trimmed value is stored as a free-text speaker
// (e.g. "radio", "TV ANCHOR", "INTERCOM") — real scripts have non-character
// sources of dialogue that aren't worth modelling as full character docs.
export async function setDialogCharacterViaGateway({ projectId, dialogId, characterName }) {
  const d = await mongoGetDialog(projectId, dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  const raw = String(characterName ?? '').trim();
  if (!raw) {
    throw new Error('character is required');
  }
  const c = await getCharacter(projectId, raw);
  const finalName = c
    ? (stripMarkdown(c.name || '').trim() || raw)
    : raw;
  await mongoUpdateDialog(projectId, d._id.toString(), { character: finalName });
  broadcastFieldsUpdated(buildRoomName('dialogs', d.beat_id.toString()), {
    changed: ['character'],
    dialog_id: d._id.toString(),
  });
  return mongoGetDialog(projectId, d._id.toString());
}

export async function createDialogViaGateway({ projectId, beatId, body, character, order, seedFragments }) {
  // Seed body / character y-doc fragments BEFORE the insert (see
  // seedNewRowFragments) and so before the ping: the SPA's CollabField for
  // the new dialog mounts against a populated fragment, not a blank body.
  const id = new ObjectId();
  const seeded = textSeeds(seedFragments, DIALOG_TEXT_FIELDS);
  await seedNewRowFragments({
    projectId,
    entityType: 'dialogs',
    beatId,
    fragments: Object.entries(seeded).map(([field, text]) => [dialogItemField(id.toString(), field), text]),
    label: 'createDialog',
  });
  const d = await mongoCreateDialog({
    id,
    projectId,
    beatId,
    body: seeded.body ?? body,
    character: seeded.character ?? character,
    direction: seeded.direction ?? '',
    order,
  });
  broadcastFieldsUpdated(buildRoomName('dialogs', String(beatId)), {
    changed: ['dialogs'],
    added_dialog_id: d._id.toString(),
  });
  return d;
}

export async function deleteDialogViaGateway({ projectId, dialogId }) {
  const d = await mongoGetDialog(projectId, dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  const beatId = d.beat_id.toString();
  await mongoDeleteDialog(dialogId);
  // Recompact orders so the remaining items are 1..N-1 contiguous.
  const remaining = await listDialogs({ projectId, beatId });
  await mongoReorderDialogs(
    beatId,
    remaining.map((x) => x._id.toString()),
  );
  broadcastFieldsUpdated(buildRoomName('dialogs', beatId), {
    changed: ['dialogs'],
    removed_dialog_id: String(dialogId),
  });
  return { ok: true, beat_id: beatId };
}

export async function reorderDialogsViaGateway({ projectId, beatId, orderedIds }) {
  const result = await mongoReorderDialogs(beatId, orderedIds);
  broadcastFieldsUpdated(buildRoomName('dialogs', String(beatId)), {
    changed: ['order'],
  });
  return result;
}

export async function deleteAllDialogsForBeatViaGateway({ projectId, beatId }) {
  const removed = await mongoDeleteDialogsForBeat(beatId);
  broadcastFieldsUpdated(buildRoomName('dialogs', String(beatId)), {
    changed: ['dialogs'],
    cleared: true,
  });
  return { ok: true, removed_count: removed.length };
}

// ─── Video prompts (Prompts tab): cuts and scenes ───────────────────────────
//
// One y-doc per beat (room: "video_prompts:<beatId>") with three fragments
// per cut — "item:<id>:title", "item:<id>:prompt", "item:<id>:start_frame_prompt",
// "item:<id>:end_frame_prompt"
// — and one per scene — "scene:<id>:floor_plan". Everything else (the
// shot-table cells, duration, the ordered reference images, the start-frame
// sub-doc, the rendered video, a scene's read / scope / load) lives in Mongo
// and is patched here with a `fields_updated` ping so open Prompts pages
// refetch. Rows of `video_prompts` are CUTS; `video_scenes` groups them.

// A frame object whose prompt is the seeded text (a seed with no frame yet
// starts one); no seed leaves the frame as given.
function withSeededPrompt(frame, prompt) {
  if (prompt === undefined) return frame;
  return { ...(frame || {}), prompt };
}

function videoPromptItemField(promptId, field) {
  return `item:${promptId}:${field}`;
}

function videoSceneField(sceneId, field) {
  return `scene:${sceneId}:${field}`;
}

const VIDEO_PROMPT_TEXT_FIELDS = new Set(['title', 'prompt', 'start_frame_prompt', 'end_frame_prompt']);
const VIDEO_SCENE_TEXT_FIELDS = new Set(['floor_plan']);

// The GridFS image ids a cut's start and end frames hold (current + one undo
// step each).
function startFrameImageIds(row) {
  return [row?.start_frame, row?.end_frame]
    .filter(Boolean)
    .flatMap((f) => [f.image_id, f.previous_image_id, f.master_image_id])
    .filter(Boolean)
    .map((id) => String(id));
}

// 'start' | 'end' → the cut field that holds that frame.
export function cutFrameKey(frame) {
  return frame === 'end' ? 'end_frame' : 'start_frame';
}

// Best-effort media cleanup for a batch of cut rows: rendered clips and the
// joined dialogue recording (attachments bucket) and start-frame images
// (images bucket).
async function deleteCutMedia(rows) {
  const fileIds = rows.flatMap((r) => [r.video_file_id, r.audio_file_id]).filter(Boolean);
  if (fileIds.length) {
    try {
      await deleteAttachments(fileIds);
    } catch (e) {
      logger.warn(`gateway: delete cut videos failed: ${e.message}`);
    }
  }
  const imageIds = rows.flatMap(startFrameImageIds);
  if (imageIds.length) {
    try {
      await deleteImages(imageIds);
    } catch (e) {
      logger.warn(`gateway: delete cut start-frame images failed: ${e.message}`);
    }
  }
}

// Best-effort cleanup of scenes' assembled MP4s (attachments bucket).
async function deleteSceneVideos(scenes) {
  const ids = (scenes || []).map((s) => s?.video_file_id).filter(Boolean).map(String);
  if (!ids.length) return;
  try {
    await deleteAttachments(ids);
  } catch (e) {
    logger.warn(`gateway: delete scene videos failed: ${e.message}`);
  }
}

export async function setVideoPromptTextFieldViaGateway({ projectId, promptId, field, text }) {
  if (!VIDEO_PROMPT_TEXT_FIELDS.has(field)) {
    throw new Error(`unknown video prompt field: ${field}`);
  }
  const p = await mongoGetVideoPrompt(projectId, promptId);
  if (!p) throw new Error(`Video prompt not found: ${promptId}`);
  await setEntityFieldMarkdown({
    projectId,
    entityType: 'video_prompts',
    entityId: p.beat_id.toString(),
    field: videoPromptItemField(p._id.toString(), field),
    markdown: text,
  });
}

// Patch the non-text scalars of a cut and ping the room. The legacy
// `durationSeconds` / `referenceImages` args still work; `patch` carries any
// structured cut field (camera, in_frame, action, dialog_ids, lock_line,
// scene_id, cut_index, …) and is validated by updateVideoPrompt.
export async function updateVideoPromptScalarsViaGateway({
  projectId,
  promptId,
  durationSeconds,
  referenceImages,
  patch,
}) {
  const p = await mongoGetVideoPrompt(projectId, promptId);
  if (!p) throw new Error(`Video prompt not found: ${promptId}`);
  const merged = {};
  if (durationSeconds !== undefined) merged.duration_seconds = durationSeconds;
  if (referenceImages !== undefined) merged.reference_images = referenceImages;
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      merged[k] = v;
    }
  }
  if (!Object.keys(merged).length) return p;
  const updated = await mongoUpdateVideoPrompt(projectId, p._id.toString(), merged);
  broadcastFieldsUpdated(buildRoomName('video_prompts', p.beat_id.toString()), {
    changed: Object.keys(merged),
    video_prompt_id: p._id.toString(),
  });
  return updated;
}

export async function createVideoPromptViaGateway({
  projectId,
  beatId,
  title = '',
  prompt = '',
  durationSeconds = null,
  referenceImages = [],
  order,
  sceneId = null,
  cutIndex = null,
  camera = null,
  inFrame = [],
  actionBy = '',
  reaction = false,
  eyeline = '',
  action = '',
  others = '',
  lastFrame = '',
  sound = '',
  crossing = false,
  contact = false,
  soundOnAction = false,
  charactersInScene = [],
  setsInScene = [],
  primarySpend = null,
  feltIntent = '',
  hook = '',
  continuesPrevious = false,
  dialogIds = [],
  lockLine = '',
  referenceBinding = '',
  exclusions = [],
  lint = [],
  startFrame = null,
  endFrame = null,
  seedFragments,
  // true → recompute the beat's global cut order after insert so a cut added
  // to a scene lands at the end of that scene rather than the end of the beat.
  recompute = false,
}) {
  // Seed the y-doc fragments BEFORE the insert (see seedNewRowFragments) and
  // so before the ping: the SPA's CollabFields for the new row mount against
  // populated fragments instead of showing blank text.
  const id = new ObjectId();
  const seeded = textSeeds(seedFragments, VIDEO_PROMPT_TEXT_FIELDS);
  await seedNewRowFragments({
    projectId,
    entityType: 'video_prompts',
    beatId,
    fragments: Object.entries(seeded).map(([field, text]) => [videoPromptItemField(id.toString(), field), text]),
    label: 'createVideoPrompt',
  });
  let p = await mongoCreateVideoPrompt({
    id,
    projectId,
    beatId,
    title: seeded.title ?? title,
    prompt: seeded.prompt ?? prompt,
    durationSeconds,
    referenceImages,
    order,
    sceneId,
    cutIndex,
    camera,
    inFrame,
    actionBy,
    reaction,
    eyeline,
    action,
    others,
    lastFrame,
    sound,
    crossing,
    contact,
    soundOnAction,
    charactersInScene,
    setsInScene,
    primarySpend,
    feltIntent,
    hook,
    continuesPrevious,
    dialogIds,
    lockLine,
    referenceBinding,
    exclusions,
    lint,
    startFrame: withSeededPrompt(startFrame, seeded.start_frame_prompt),
    endFrame: withSeededPrompt(endFrame, seeded.end_frame_prompt),
  });
  if (recompute) {
    await mongoRecomputeCutOrder(beatId);
    p = (await mongoGetVideoPrompt(projectId, p._id.toString())) || p;
  }
  broadcastFieldsUpdated(buildRoomName('video_prompts', String(beatId)), {
    changed: ['video_prompts'],
    added_video_prompt_id: p._id.toString(),
  });
  return p;
}

// Delete one cut (its rendered video and start-frame images, best-effort),
// then recompact the beat's order (and its scene's cut_index) to 1..N-1.
export async function deleteVideoPromptViaGateway({ projectId, promptId }) {
  const p = await mongoGetVideoPrompt(projectId, promptId);
  if (!p) throw new Error(`Video prompt not found: ${promptId}`);
  const beatId = p.beat_id.toString();
  await mongoDeleteVideoPrompt(p._id);
  await deleteCutMedia([p]);
  await mongoRecomputeCutOrder(beatId);
  await clearAssembledVideosForBeat(projectId, beatId, p.scene_id ? { sceneId: String(p.scene_id) } : { beatOnly: true });
  broadcastFieldsUpdated(buildRoomName('video_prompts', beatId), {
    changed: ['video_prompts'],
    removed_video_prompt_id: p._id.toString(),
  });
  return { ok: true, beat_id: beatId };
}

export async function reorderVideoPromptsViaGateway({ projectId, beatId, orderedIds }) {
  const result = await mongoReorderVideoPrompts(beatId, orderedIds);
  await clearAssembledVideosForBeat(projectId, beatId);
  broadcastFieldsUpdated(buildRoomName('video_prompts', String(beatId)), {
    changed: ['order'],
  });
  return result;
}

// Wipe every scene AND every cut of a beat, deleting rendered videos and
// start-frame images (best-effort). The Prompts tab's "Delete all".
export async function deleteAllVideoPromptsForBeatViaGateway({ projectId, beatId }) {
  const removed = await mongoDeleteVideoPromptsForBeat(beatId);
  const scenes = await mongoDeleteVideoScenesForBeat(beatId);
  await deleteCutMedia(removed);
  await deleteSceneVideos(scenes);
  await clearAssembledVideosForBeat(projectId, beatId, { beatOnly: true });
  broadcastFieldsUpdated(buildRoomName('video_prompts', String(beatId)), {
    changed: ['video_prompts', 'video_scenes'],
    cleared: true,
  });
  return { ok: true, removed_count: removed.length, scenes_removed: scenes.length };
}

export const deleteAllVideoScenesForBeatViaGateway = deleteAllVideoPromptsForBeatViaGateway;

// Persist a rendered video onto a cut. videoFileId=null clears the slot. `provider`
// ('fal' | 'comfy', default 'fal') and `comfy` ({ template, model_id, params,
// prompt_id }) record which path rendered the clip.
export async function setVideoPromptVideoViaGateway({
  projectId,
  promptId,
  videoFileId,
  durationSeconds = null,
  modelId = null,
  modelLabel = null,
  falModel = null,
  modelLab = null,
  modelFamily = null,
  modelAddedAt = null,
  parameters = null,
  costUsd = null,
  provider = null,
  comfy = null,
}) {
  const p = await mongoGetVideoPrompt(projectId, promptId);
  if (!p) throw new Error(`Video prompt not found: ${promptId}`);
  const patch = {
    video_file_id: videoFileId == null ? null : String(videoFileId),
  };
  if (videoFileId == null) {
    patch.video_duration_seconds = null;
    patch.video_generated_at = null;
    patch.video_model_id = null;
    patch.video_model_label = null;
    patch.video_fal_model = null;
    patch.video_model_lab = null;
    patch.video_model_family = null;
    patch.video_model_added_at = null;
    patch.video_parameters = null;
    patch.video_cost_usd = null;
    patch.video_provider = null;
    patch.video_comfy = null;
  } else {
    if (durationSeconds != null && Number.isFinite(Number(durationSeconds))) {
      patch.video_duration_seconds = Number(durationSeconds);
    }
    patch.video_generated_at = new Date();
    patch.video_model_id = modelId ? String(modelId) : null;
    patch.video_model_label = modelLabel ? String(modelLabel) : null;
    patch.video_fal_model = falModel ? String(falModel) : null;
    patch.video_model_lab = modelLab ? String(modelLab) : null;
    patch.video_model_family = modelFamily ? String(modelFamily) : null;
    patch.video_model_added_at = modelAddedAt ?? null;
    patch.video_parameters =
      parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : null;
    patch.video_cost_usd =
      typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null;
    patch.video_provider = provider === 'comfy' ? 'comfy' : 'fal';
    patch.video_comfy = comfy && typeof comfy === 'object' && !Array.isArray(comfy) ? comfy : null;
  }
  await mongoUpdateVideoPrompt(projectId, p._id.toString(), patch);
  broadcastFieldsUpdated(buildRoomName('video_prompts', p.beat_id.toString()), {
    changed: Object.keys(patch),
    video_prompt_id: p._id.toString(),
  });
  return mongoGetVideoPrompt(projectId, p._id.toString());
}

// The joined dialogue recording a lip-sync render of a cut used : probes the duration, deletes the
// previous concat file (best-effort) and pings the room. audioFileId=null clears.
export async function setVideoPromptAudioViaGateway({ projectId, promptId, audioFileId }) {
  const p = await mongoGetVideoPrompt(projectId, promptId);
  if (!p) throw new Error(`Video prompt not found: ${promptId}`);
  const patch = { audio_file_id: audioFileId == null ? null : String(audioFileId) };
  if (audioFileId == null) {
    patch.audio_duration_seconds = null;
  } else {
    try {
      const read = await readAttachmentBuffer(audioFileId);
      if (read?.buffer) {
        const mime = read.file?.contentType || read.file?.metadata?.content_type || null;
        const dur = await probeAudioDurationSeconds(read.buffer, mime);
        patch.audio_duration_seconds = dur || null;
      } else {
        patch.audio_duration_seconds = null;
      }
    } catch (e) {
      logger.warn(`gateway: cut audio duration probe failed for ${audioFileId}: ${e.message}`);
      patch.audio_duration_seconds = null;
    }
  }
  const updated = await mongoUpdateVideoPrompt(projectId, p._id.toString(), patch);
  const oldId = p.audio_file_id ? String(p.audio_file_id) : null;
  if (oldId && oldId !== patch.audio_file_id) {
    try {
      await deleteAttachments([oldId]);
    } catch (e) {
      logger.warn(`gateway: previous cut audio ${oldId} cleanup failed: ${e.message}`);
    }
  }
  broadcastFieldsUpdated(buildRoomName('video_prompts', p.beat_id.toString()), {
    changed: Object.keys(patch),
    video_prompt_id: p._id.toString(),
  });
  return updated;
}

// Replace a cut's start-frame (or, with `frame: 'end'`, end-frame) sub-doc.
// When the image changes, the previous image becomes the one-step undo target
// (`previous_image_id`) and the older undo target is deleted (best-effort).
// `startFrame: null` clears the slot and deletes both files. A missing
// `prompt` keeps the current prompt (it is a collab fragment the caller may
// not have in hand).
// `keepUndo`: the image being replaced is an intermediate (a repair of a
// repair) — it is deleted and the existing undo target is kept, so Undo
// still returns the frame as it was before the repairs began.
export async function setVideoPromptStartFrameViaGateway({ projectId, promptId, startFrame, frame = 'start', keepUndo = false }) {
  const key = cutFrameKey(frame);
  const p = await mongoGetVideoPrompt(projectId, promptId);
  if (!p) throw new Error(`Video prompt not found: ${promptId}`);
  const prev = p[key] || null;
  if (startFrame == null) {
    await deleteCutMedia([{ [key]: prev }]);
    const cleared = await mongoUpdateVideoPrompt(projectId, p._id.toString(), { [key]: null });
    broadcastFieldsUpdated(buildRoomName('video_prompts', p.beat_id.toString()), {
      changed: [key],
      video_prompt_id: p._id.toString(),
    });
    return cleared;
  }
  const next = normalizeStartFrame(startFrame);
  if (startFrame.prompt === undefined && prev) next.prompt = prev.prompt || '';
  const prevImage = prev?.image_id ? String(prev.image_id) : null;
  const nextImage = next.image_id ? String(next.image_id) : null;
  const undoTarget = prev?.previous_image_id ? String(prev.previous_image_id) : null;
  if (keepUndo && prevImage && prevImage !== nextImage && undoTarget && undoTarget !== prevImage && undoTarget !== nextImage) {
    try {
      await deleteImages([prevImage]);
    } catch (e) {
      logger.warn(`gateway: delete intermediate ${frame} frame ${prevImage} failed: ${e.message}`);
    }
    next.previous_image_id = new ObjectId(undoTarget);
  } else if (prevImage && prevImage !== nextImage) {
    const older = prev.previous_image_id ? String(prev.previous_image_id) : null;
    if (older && older !== prevImage && older !== nextImage) {
      try {
        await deleteImages([older]);
      } catch (e) {
        logger.warn(`gateway: delete older ${frame} frame ${older} failed: ${e.message}`);
      }
    }
    next.previous_image_id = new ObjectId(prevImage);
  } else if (!next.previous_image_id && prev?.previous_image_id) {
    next.previous_image_id = prev.previous_image_id;
  }
  // A master plate that is no longer this frame's is dropped.
  const prevMaster = prev?.master_image_id ? String(prev.master_image_id) : null;
  if (prevMaster && prevMaster !== (next.master_image_id ? String(next.master_image_id) : null)) {
    try {
      await deleteImages([prevMaster]);
    } catch (e) {
      logger.warn(`gateway: delete ${frame} frame master ${prevMaster} failed: ${e.message}`);
    }
  }
  const updated = await mongoUpdateVideoPrompt(projectId, p._id.toString(), { [key]: next });
  broadcastFieldsUpdated(buildRoomName('video_prompts', p.beat_id.toString()), {
    changed: [key],
    video_prompt_id: p._id.toString(),
  });
  return updated;
}

// Swap the current start-frame (or end-frame) image back to the undo target.
// The discarded current image is deleted (best-effort). Throws when there is
// nothing to undo.
export async function undoVideoPromptStartFrameViaGateway({ projectId, promptId, frame = 'start' }) {
  const key = cutFrameKey(frame);
  const p = await mongoGetVideoPrompt(projectId, promptId);
  if (!p) throw new Error(`Video prompt not found: ${promptId}`);
  const prev = p[key];
  if (!prev?.previous_image_id) throw new Error(`No previous ${frame} frame to restore`);
  const discarded = prev.image_id ? String(prev.image_id) : null;
  const next = {
    ...prev,
    image_id: prev.previous_image_id,
    previous_image_id: null,
    generated_at: new Date(),
  };
  const updated = await mongoUpdateVideoPrompt(projectId, p._id.toString(), { [key]: next });
  if (discarded && discarded !== String(next.image_id)) {
    try {
      await deleteImages([discarded]);
    } catch (e) {
      logger.warn(`gateway: delete discarded ${frame} frame ${discarded} failed: ${e.message}`);
    }
  }
  broadcastFieldsUpdated(buildRoomName('video_prompts', p.beat_id.toString()), {
    changed: [key],
    video_prompt_id: p._id.toString(),
  });
  return updated;
}

// ── Scenes ──────────────────────────────────────────────────────────────────

export async function createVideoSceneViaGateway({
  projectId,
  beatId,
  order,
  title = '',
  slug = '',
  setNames = [],
  characterNames = [],
  textSpan = null,
  directorsRead = null,
  kind = 'scene',
  montageSubjects = [],
  intention = '',
  tempo = '',
  scope = null,
  floorPlan = '',
  dialogIds = [],
  load = null,
  seedFragments,
}) {
  const id = new ObjectId();
  const seeded = textSeeds(seedFragments, VIDEO_SCENE_TEXT_FIELDS);
  await seedNewRowFragments({
    projectId,
    entityType: 'video_prompts',
    beatId,
    fragments: Object.entries(seeded).map(([field, text]) => [videoSceneField(id.toString(), field), text]),
    label: 'createVideoScene',
  });
  const s = await mongoCreateVideoScene({
    id,
    projectId,
    beatId,
    order,
    title,
    slug,
    setNames,
    characterNames,
    textSpan,
    directorsRead,
    kind,
    montageSubjects,
    intention,
    tempo,
    scope,
    floorPlan: seeded.floor_plan ?? floorPlan,
    dialogIds,
    load,
  });
  broadcastFieldsUpdated(buildRoomName('video_prompts', String(beatId)), {
    changed: ['video_scenes'],
    added_video_scene_id: s._id.toString(),
  });
  return s;
}

export async function setVideoSceneTextFieldViaGateway({ projectId, sceneId, field, text }) {
  if (!VIDEO_SCENE_TEXT_FIELDS.has(field)) {
    throw new Error(`unknown video scene field: ${field}`);
  }
  const s = await mongoGetVideoScene(projectId, sceneId);
  if (!s) throw new Error(`Video scene not found: ${sceneId}`);
  await setEntityFieldMarkdown({
    projectId,
    entityType: 'video_prompts',
    entityId: s.beat_id.toString(),
    field: videoSceneField(s._id.toString(), field),
    markdown: text,
  });
}

// Patch a scene's scalars (title, slug, set/character names, text span,
// director's read, intention, scope, dialog ids, load) and ping the room.
export async function updateVideoSceneViaGateway({ projectId, sceneId, patch }) {
  const s = await mongoGetVideoScene(projectId, sceneId);
  if (!s) throw new Error(`Video scene not found: ${sceneId}`);
  const merged = {};
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      merged[k] = v;
    }
  }
  if (!Object.keys(merged).length) return s;
  const updated = await mongoUpdateVideoScene(projectId, s._id.toString(), merged);
  broadcastFieldsUpdated(buildRoomName('video_prompts', s.beat_id.toString()), {
    changed: Object.keys(merged),
    video_scene_id: s._id.toString(),
  });
  return updated;
}

// Delete a scene and every cut in it (videos + start-frame images
// best-effort), renumber the remaining scenes and recompute the beat's cut
// order.
export async function deleteVideoSceneViaGateway({ projectId, sceneId }) {
  const s = await mongoGetVideoScene(projectId, sceneId);
  if (!s) throw new Error(`Video scene not found: ${sceneId}`);
  const beatId = s.beat_id.toString();
  const cuts = await mongoDeleteVideoPromptsForScene(s._id);
  await deleteCutMedia(cuts);
  await deleteSceneVideos([s]);
  await mongoDeleteVideoScene(s._id);
  const remaining = await listVideoScenes({ projectId, beatId });
  const remainingIds = remaining.map((x) => x._id.toString());
  await mongoReorderVideoScenes(beatId, remainingIds);
  await mongoRecomputeCutOrder(beatId, remainingIds);
  await clearAssembledVideosForBeat(projectId, beatId, { beatOnly: true });
  broadcastFieldsUpdated(buildRoomName('video_prompts', beatId), {
    changed: ['video_scenes', 'video_prompts'],
    removed_video_scene_id: s._id.toString(),
  });
  return { ok: true, beat_id: beatId, cuts_removed: cuts.length };
}

export async function reorderVideoScenesViaGateway({ projectId, beatId, orderedIds }) {
  const scenes = await mongoReorderVideoScenes(beatId, orderedIds);
  await mongoRecomputeCutOrder(
    beatId,
    scenes.map((x) => x._id.toString()),
  );
  await clearAssembledVideosForBeat(projectId, beatId, { beatOnly: true });
  broadcastFieldsUpdated(buildRoomName('video_prompts', String(beatId)), {
    changed: ['video_scenes', 'order'],
  });
  return scenes;
}

export async function reorderCutsInSceneViaGateway({ projectId, sceneId, orderedIds }) {
  const s = await mongoGetVideoScene(projectId, sceneId);
  if (!s) throw new Error(`Video scene not found: ${sceneId}`);
  const cuts = await mongoReorderCutsInScene(s._id, orderedIds);
  await clearAssembledVideosForBeat(projectId, s.beat_id.toString(), { sceneId: s._id.toString() });
  broadcastFieldsUpdated(buildRoomName('video_prompts', s.beat_id.toString()), {
    changed: ['order'],
    video_scene_id: s._id.toString(),
  });
  return cuts;
}

// Ping the project-wide singleton room so any open Table of Contents refetches
// its beat list. Beat CONTENT lives in per-beat rooms; this only signals "the
// beat list/order changed". No-op (returns false) when no clients are connected.
export async function broadcastBeatsChanged(projectId) {
  projectId = await resolveProjectId(projectId);
  return broadcastFieldsUpdated(buildRoomName('plot', String(projectId)), {
    changed: ['beats'],
  });
}

export async function reorderBeatsViaGateway({ projectId, orderedIds }) {
  const { reorderBeats } = await import('../mongo/plots.js');
  const beats = await reorderBeats(projectId, orderedIds);
  await broadcastBeatsChanged(projectId);
  const editor = currentEditor();
  if (editor) {
    const pid = await resolveProjectId(projectId);
    announceBeatsReordered({ projectId: pid, editor });
  }
  return beats;
}

export async function createBeatViaGateway(opts) {
  const { createBeat } = await import('../mongo/plots.js');
  if (typeof opts?.body === 'string') opts = { ...opts, body: linesToHardBreaks(opts.body) };
  const beat = await createBeat(opts);
  await broadcastBeatsChanged(opts.projectId);
  // Attribute the create to the in-scope web user (SPA request or web chat
  // agent). Discord-run agents have no editor scope and surface the result in
  // their own channel reply instead. Fire-and-forget, like maybeAnnounceCast.
  const editor = currentEditor();
  if (editor) {
    const pid = await resolveProjectId(opts.projectId);
    announceBeatLifecycle({ projectId: pid, beat, editor, verb: 'created' });
  }
  return beat;
}

// Full delete: drop the beat from the plot, then cascade to everything keyed
// off its _id — dialogs, scenes and cuts (with their media), the legacy beat
// gallery images, and the beat's RAG chunks. Both the agent's delete_beat tool and DELETE /api/beat/:id
// route here so the two entry points can never drift in what they clean up.
export async function deleteBeatViaGateway(projectId, identifier) {
  const { deleteBeat } = await import('../mongo/plots.js');
  const target = await getBeat(projectId, String(identifier));
  if (!target) throw new Error(`Beat not found: ${identifier}`);
  const beatId = target._id.toString();
  // The assembled beat MP4 (plus a legacy storyboard-era one, if
  // scripts/purge-storyboards.js has not been run on this database).
  const beatVideoIds = [target.video_file_id, target.prompts_video_file_id].filter(Boolean).map(String);
  if (beatVideoIds.length) {
    try {
      await deleteAttachments(beatVideoIds);
    } catch (e) {
      logger.warn(`gateway: delete beat videos ${beatVideoIds.join(',')} failed: ${e.message}`);
    }
  }
  const res = await deleteBeat(projectId, beatId);
  const dialogs = await mongoDeleteDialogsForBeat(beatId);
  const videoPrompts = await mongoDeleteVideoPromptsForBeat(beatId);
  const videoScenes = await mongoDeleteVideoScenesForBeat(beatId);
  // Cut media: rendered clips + start-frame images (current and undo step);
  // scene MP4s.
  await deleteCutMedia(videoPrompts);
  await deleteSceneVideos(videoScenes);
  if (res.image_ids.length) {
    await deleteImages(res.image_ids).catch((e) =>
      logger.warn(`gateway: delete beat images failed: ${e.message}`),
    );
  }
  deleteEntity('beat', beatId).catch(() => {});
  await broadcastBeatsChanged(projectId);
  const editor = currentEditor();
  if (editor) {
    const pid = await resolveProjectId(projectId);
    announceBeatLifecycle({ projectId: pid, beat: res, editor, verb: 'deleted' });
  }
  return {
    ...res,
    dialogs_removed: dialogs.length,
    video_prompts_removed: videoPrompts.length,
    video_scenes_removed: videoScenes.length,
  };
}

// Ping the project-wide singleton room so any open TOC refetches its set /
// character list (same convention as broadcastBeatsChanged).
export async function broadcastSetsChanged(projectId) {
  projectId = await resolveProjectId(projectId);
  return broadcastFieldsUpdated(buildRoomName('plot', String(projectId)), {
    changed: ['sets'],
  });
}

export async function broadcastCharactersChanged(projectId) {
  projectId = await resolveProjectId(projectId);
  return broadcastFieldsUpdated(buildRoomName('plot', String(projectId)), {
    changed: ['characters'],
  });
}

function duplicateNameError(kind, name) {
  const e = new Error(`A ${kind} named "${stripMarkdown(String(name))}" already exists in this project.`);
  e.status = 409;
  return e;
}

export async function createSetViaGateway({ projectId, name, description }) {
  const existing = await getSet(projectId, String(name));
  if (existing) throw duplicateNameError('set', name);
  const set = await mongoCreateSet({ projectId, name, description });
  await broadcastSetsChanged(projectId);
  const editor = currentEditor();
  if (editor) {
    const pid = await resolveProjectId(projectId);
    announceSetLifecycle({ projectId: pid, set, editor, verb: 'created' });
  }
  return set;
}

// Full delete: unlink from every beat, drop the doc, purge GridFS bytes
// (gallery images, artwork results, attachments), and drop RAG chunks.
export async function deleteSetViaGateway(projectId, identifier) {
  const { unlinkSetFromAllBeats } = await import('../mongo/plots.js');
  const s = await getSet(projectId, identifier);
  if (!s) throw new Error(`Set not found: ${identifier}`);
  const { unlinked_from } = await unlinkSetFromAllBeats(projectId, s.name);
  const res = await mongoDeleteSet(projectId, s._id.toString());
  if (res.image_ids.length) {
    await deleteImages(res.image_ids).catch((e) =>
      logger.warn(`gateway: delete set images failed: ${e.message}`),
    );
  }
  if (res.attachment_ids.length) {
    await deleteAttachments(res.attachment_ids).catch((e) =>
      logger.warn(`gateway: delete set attachments failed: ${e.message}`),
    );
  }
  deleteEntity('set', s._id.toString()).catch(() => {});
  await broadcastSetsChanged(projectId);
  const editor = currentEditor();
  if (editor) {
    const pid = await resolveProjectId(projectId);
    announceSetLifecycle({ projectId: pid, set: s, editor, verb: 'deleted' });
  }
  return { ...res, unlinked_from };
}

export async function createCharacterViaGateway({ projectId, name, hollywood_actor, fields }) {
  const existing = await getCharacter(projectId, String(name));
  if (existing) throw duplicateNameError('character', name);
  const character = await mongoCreateCharacter({ projectId, name, hollywood_actor, fields });
  await broadcastCharactersChanged(projectId);
  const editor = currentEditor();
  if (editor) {
    const pid = await resolveProjectId(projectId);
    announceCharacterLifecycle({ projectId: pid, character, editor, verb: 'created' });
  }
  return character;
}

// Attach or detach a dialog item's recorded audio file. Pass `audioFileId:
// null` to unlink (the GridFS bytes are left in place).
export async function setDialogAudioViaGateway({ projectId, dialogId, audioFileId }) {
  const d = await mongoGetDialog(projectId, dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  const patch = {
    audio_file_id: audioFileId == null ? null : String(audioFileId),
  };
  // Probe the recording's duration (so) so
  // shot duration estimates and lip-sync planning never need a fal round
  // trip. Probe failures log and store null; the planner falls back to a
  // speech-rate estimate for that line.
  if (audioFileId == null) {
    patch.audio_duration_seconds = null;
  } else {
    try {
      const { probeDialogAudioDuration } = await import('./dialogAudioProbe.js');
      patch.audio_duration_seconds = (await probeDialogAudioDuration(audioFileId)) || null;
    } catch (e) {
      logger.warn(`gateway: dialog audio duration probe failed for ${audioFileId}: ${e.message}`);
      patch.audio_duration_seconds = null;
    }
  }
  await mongoUpdateDialog(projectId, dialogId, patch);
  broadcastFieldsUpdated(buildRoomName('dialogs', d.beat_id.toString()), {
    changed: Object.keys(patch),
    dialog_id: String(dialogId),
  });
  return mongoGetDialog(projectId, dialogId);
}

// ─── Library ───────────────────────────────────────────────────────────────
//
// All library images share one y-doc (room: "library") with two fragments per
// image: "library:<imageId>:name" and "library:<imageId>:description". Mongo
// is the source of truth — the persist hook in roomRegistry writes back to
// images.files.metadata. These gateway helpers exist so REST handlers and
// the agent can write through the same path the SPA uses.

function libraryFieldName(imageId, field) {
  return `library:${String(imageId)}:${field}`;
}

export async function setLibraryImageMetaViaGateway({ projectId, imageId, name, description }) {
  projectId = await resolveProjectId(projectId);
  if (name === undefined && description === undefined) return;
  if (name !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'library',
      entityId: 'library',
      field: libraryFieldName(imageId, 'name'),
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'library',
      entityId: 'library',
      field: libraryFieldName(imageId, 'description'),
      markdown: description,
    });
  }
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    image_id: String(imageId),
  });
}

// Owned-image (character / beat) metadata writer. Mirrors
// setLibraryImageMetaViaGateway but routes through the entity's own y-doc
// room so connected SPAs see the bot's caret in the image card and the
// values appear live. Falls back to direct Mongo via setOwnedImageMeta when
// Hocuspocus isn't running (tests, CLI).
export async function setOwnedImageMetaViaGateway({
  projectId,
  imageId,
  ownerType,
  ownerId,
  name,
  description,
}) {
  if (name === undefined && description === undefined) return;
  if (ownerType !== 'beat' && ownerType !== 'character' && ownerType !== 'set') {
    throw new Error(`setOwnedImageMetaViaGateway: unsupported ownerType "${ownerType}"`);
  }
  const idStr = String(ownerId || '');
  if (!idStr) throw new Error('setOwnedImageMetaViaGateway: ownerId required');
  if (name !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: ownerType,
      entityId: idStr,
      field: `image:${String(imageId)}:name`,
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: ownerType,
      entityId: idStr,
      field: `image:${String(imageId)}:description`,
      markdown: description,
    });
  }
  broadcastFieldsUpdated(buildRoomName(ownerType, idStr), {
    changed: ['image_meta'],
    image_id: String(imageId),
  });
}

function libraryAttachmentFieldName(attachmentId, field) {
  return `library_attachment:${String(attachmentId)}:${field}`;
}

export async function setLibraryAttachmentMetaViaGateway({ projectId, attachmentId, name, description }) {
  projectId = await resolveProjectId(projectId);
  if (name === undefined && description === undefined) return;
  if (name !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'library',
      entityId: 'library',
      field: libraryAttachmentFieldName(attachmentId, 'name'),
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: 'library',
      entityId: 'library',
      field: libraryAttachmentFieldName(attachmentId, 'description'),
      markdown: description,
    });
  }
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_attachments'],
    attachment_id: String(attachmentId),
  });
}

// Owned-attachment (character / beat) metadata writer. Mirrors
// setOwnedImageMetaViaGateway for attachments. Falls back to direct Mongo via
// setOwnedAttachmentMeta when Hocuspocus isn't running.
export async function setOwnedAttachmentMetaViaGateway({
  projectId,
  attachmentId,
  ownerType,
  ownerId,
  name,
  description,
}) {
  if (name === undefined && description === undefined) return;
  if (ownerType !== 'beat' && ownerType !== 'character') {
    throw new Error(`setOwnedAttachmentMetaViaGateway: unsupported ownerType "${ownerType}"`);
  }
  const idStr = String(ownerId || '');
  if (!idStr) throw new Error('setOwnedAttachmentMetaViaGateway: ownerId required');
  if (name !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: ownerType,
      entityId: idStr,
      field: `attachment:${String(attachmentId)}:name`,
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
      projectId,
      entityType: ownerType,
      entityId: idStr,
      field: `attachment:${String(attachmentId)}:description`,
      markdown: description,
    });
  }
  broadcastFieldsUpdated(buildRoomName(ownerType, idStr), {
    changed: ['attachment_meta'],
    attachment_id: String(attachmentId),
  });
}

// Called from REST handlers and agent tools after a fresh upload. The
// library room composition has changed (new fragments exist for the new
// image's name/description); the broadcast prompts the SPA to refetch.
export async function addLibraryImageViaGateway({ projectId, imageMeta }) {
  projectId = await resolveProjectId(projectId);
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    added_image_id: imageMeta?._id ? String(imageMeta._id) : null,
  });
  return imageMeta;
}

export async function removeLibraryImageViaGateway({ projectId, imageId }) {
  projectId = await resolveProjectId(projectId);
  await deleteImage(imageId);
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    removed_image_id: String(imageId),
  });
}

// Replace one library image with another, copying name/description from the
// source onto the new image and deleting the source. Both ids must currently
// be library images (owner_type === null).
export async function replaceLibraryImageViaGateway({ projectId, sourceImageId, newImageId, copyMetadata = true }) {
  projectId = await resolveProjectId(projectId);
  const src = await findImageFile(sourceImageId);
  if (!src) throw new Error(`Source image not found: ${sourceImageId}`);
  const next = await findImageFile(newImageId);
  if (!next) throw new Error(`New image not found: ${newImageId}`);
  const srcOwner = src.metadata?.owner_type;
  const nextOwner = next.metadata?.owner_type;
  if (srcOwner !== null && srcOwner !== undefined) {
    throw new Error(`Source image ${sourceImageId} is not in the library (owner_type=${srcOwner}).`);
  }
  if (nextOwner !== null && nextOwner !== undefined) {
    throw new Error(`New image ${newImageId} is not in the library (owner_type=${nextOwner}).`);
  }
  if (copyMetadata) {
    const name = src.metadata?.name || '';
    const description = src.metadata?.description || '';
    if (name || description) {
      await setLibraryImageMeta(newImageId, { name, description });
    }
  }
  await deleteImage(sourceImageId);
  broadcastFieldsUpdated(buildRoomName('library', projectId), {
    changed: ['library_images'],
    removed_image_id: String(sourceImageId),
    added_image_id: String(newImageId),
  });
  return { ok: true, new_image_id: String(newImageId) };
}

// ─── Inspection helpers ────────────────────────────────────────────────────

export async function getEntityFieldMarkdown({ projectId, entityType, entityId, field }) {
  projectId = await resolveProjectId(projectId);
  const { fragmentToMarkdown } = await he();
  const roomName = roomNameFor(entityType, entityId, projectId);
  let out;
  await withDirectDocument(roomName, gatewayEditContext(), (document) => {
    out = fragmentToMarkdown(document, field);
  });
  return out;
}
