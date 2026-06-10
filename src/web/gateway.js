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
import { resolveProjectId } from '../mongo/projects.js';

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
  updateCharacter as mongoUpdateCharacter,
  pushCharacterImage,
  pullCharacterImage,
  replaceCharacterImage,
  pushCharacterAttachment,
  pullCharacterAttachment,
} from '../mongo/characters.js';
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
  createStoryboard as mongoCreateStoryboard,
  updateStoryboard as mongoUpdateStoryboard,
  addFrame as mongoAddFrame,
  removeFrame as mongoRemoveFrame,
  reorderFrames as mongoReorderFrames,
  setFrameImage as mongoSetFrameImage,
  setFramePrompt as mongoSetFramePrompt,
  rotateFrameImageEdit as mongoRotateFrameImageEdit,
  undoFrameImageEdit as mongoUndoFrameImageEdit,
  deleteStoryboard as mongoDeleteStoryboard,
  deleteStoryboardsForBeat as mongoDeleteStoryboardsForBeat,
  clearAllFrameImagesForBeat as mongoClearAllFrameImagesForBeat,
  getStoryboard as mongoGetStoryboard,
  reorderStoryboardsForBeat as mongoReorderStoryboards,
  pushFrameReferenceImage as mongoPushFrameReferenceImage,
  pullFrameReferenceImage as mongoPullFrameReferenceImage,
  pushFrameReferenceImages as mongoPushFrameReferenceImages,
  setFrameReferenceImages as mongoSetFrameReferenceImages,
  listStoryboards,
} from '../mongo/storyboards.js';
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
  setMainCharacterImage,
  removeCharacterImage,
  detachImageFromCurrentOwner,
} from '../mongo/files.js';
import {
  setLibraryImageMeta,
  setOwnedImageMeta,
  setImageOwner,
  findImageFile,
  deleteImage,
} from '../mongo/images.js';
import { copyImageToNewOwner } from '../mongo/imageCopy.js';
import {
  setLibraryAttachmentMeta,
  setOwnedAttachmentMeta,
  findAttachmentFile,
  readAttachmentBuffer,
  copyAttachmentBuffer,
  attachExistingAttachmentToBeat,
  attachExistingAttachmentToCharacter,
  attachExistingAttachmentToDirectorNote,
} from '../mongo/attachments.js';
import { probeAudioDurationSeconds } from '../fal/videoPricing.js';
import { enqueueReindex } from '../rag/queue.js';
import { deleteEntity } from '../rag/indexer.js';
import { stripMarkdown } from '../util/markdown.js';

let botDisplayName = 'Screenplay Bot';

export function setBotDisplayName(name) {
  if (typeof name === 'string' && name.trim()) botDisplayName = name.trim();
}

export function getBotDisplayName() {
  return botDisplayName;
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
  if (entityType === 'storyboards') {
    const fm = field.match(/^item:([a-f0-9]{24}):frame:([a-f0-9]{24}):prompt$/);
    if (fm) {
      const sb = await mongoGetStoryboard(projectId, fm[1]);
      if (!sb) throw new Error(`Storyboard not found: ${fm[1]}`);
      const frame = (sb.frames || []).find((f) => f._id.toString() === fm[2]);
      return String(frame?.prompt || '');
    }
    const m = field.match(/^item:([a-f0-9]{24}):(text_prompt|summary)$/);
    if (!m) throw new Error(`gateway fallback: unknown storyboards field "${field}"`);
    const sb = await mongoGetStoryboard(projectId, m[1]);
    if (!sb) throw new Error(`Storyboard not found: ${m[1]}`);
    return String(sb[m[2]] || '');
  }
  if (entityType === 'dialogs') {
    const m = field.match(/^item:([a-f0-9]{24}):(body|character)$/);
    if (!m) throw new Error(`gateway fallback: unknown dialogs field "${field}"`);
    const d = await mongoGetDialog(projectId, m[1]);
    if (!d) throw new Error(`Dialog not found: ${m[1]}`);
    return String(d[m[2]] || '');
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
  if (entityType === 'notes' && field.startsWith('note:') && field.endsWith(':text')) {
    const noteId = field.slice('note:'.length, -':text'.length);
    const { editDirectorNote } = await import('../mongo/directorNotes.js');
    return editDirectorNote({ projectId, noteId, text: args.markdown });
  }
  if (entityType === 'plot') {
    return Plots.updatePlot(projectId, { [field]: args.markdown });
  }
  if (entityType === 'storyboards') {
    const fm = field.match(/^item:([a-f0-9]{24}):frame:([a-f0-9]{24}):prompt$/);
    if (fm) return mongoSetFramePrompt(projectId, fm[1], fm[2], args.markdown);
    const m = field.match(/^item:([a-f0-9]{24}):(text_prompt|summary)$/);
    if (!m) throw new Error(`gateway fallback: unknown storyboards field "${field}"`);
    return mongoUpdateStoryboard(projectId, m[1], { [m[2]]: args.markdown });
  }
  if (entityType === 'dialogs') {
    if (field === 'dialog_notes') {
      return Plots.updateBeat(projectId, entityId, { dialog_notes: args.markdown });
    }
    const m = field.match(/^item:([a-f0-9]{24}):(body|character)$/);
    if (!m) throw new Error(`gateway fallback: unknown dialogs field "${field}"`);
    return mongoUpdateDialog(projectId, m[1], { [m[2]]: args.markdown });
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

export async function setEntityFieldMarkdown({ projectId, entityType, entityId, field, markdown }) {
  projectId = await resolveProjectId(projectId);
  if (!isHocuspocusRunning()) {
    await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'set', markdown });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return;
  }
  const { setFragmentMarkdown } = await he();
  const roomName = roomNameFor(entityType, entityId, projectId);
  await withDirectDocument(roomName, { actor: 'bot' }, (document) => {
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
  await withDirectDocument(roomName, { actor: 'bot' }, (document) => {
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
  if (!isHocuspocusRunning()) {
    const result = await fallbackTextWrite({ projectId, entityType, entityId, field, op: 'append', content });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return result?.body ?? '';
  }
  const { appendToFragmentMarkdown } = await he();
  const roomName = roomNameFor(entityType, entityId, projectId);
  let next;
  await withDirectDocument(roomName, { actor: 'bot' }, (document) => {
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
    k === 'characters';
  if (!Object.keys(patch).some((k) => isRecognizedKey(k) && patch[k] !== undefined)) {
    throw new Error(
      `update_beat: \`patch\` has no recognized fields. Expected one of: name, body, order, characters. Got keys: [${Object.keys(patch).join(', ')}].`,
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
  // order and characters are non-text → hit Mongo directly.
  const onlyDiscrete = {};
  if (patch.order !== undefined) onlyDiscrete.order = patch.order;
  if (Array.isArray(patch.characters)) onlyDiscrete.characters = patch.characters;
  if (Object.keys(onlyDiscrete).length) {
    const { updateBeat: mongoUpdateBeat } = await import('../mongo/plots.js');
    await mongoUpdateBeat(projectId, beatId, onlyDiscrete);
    broadcastFieldsUpdated(buildRoomName('beat', beatId), {
      changed: Object.keys(onlyDiscrete),
    });
  }
  return getBeat(projectId, beatId);
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
  const result = await setMainCharacterImage({ character: c._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['main_image_id'],
  });
  return result;
}

export async function removeCharacterImageViaGateway({ projectId, character, imageId }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await removeCharacterImage({ character: c._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['images', 'main_image_id'],
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
  const result = await mongoPatchArtwork({ hostType, hostId, artworkId, patch });
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
  return result.mainImageIdChange?.changed
    ? ['artworks', 'main_image_id']
    : ['artworks'];
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
  const result = await mongoUndoArtworkEdit({ hostType, hostId, artworkId });
  await tryDeleteImage(result.orphanedImageId, 'undone artwork');
  broadcastFieldsUpdated(artworkRoomName(hostType, result.host_id), {
    changed: artworkChangedFields(result),
  });
  return result;
}

export async function removeArtworkViaGateway({ projectId, hostType, hostId, artworkId }) {
  const result = await mongoRemoveArtwork({ hostType, hostId, artworkId });
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

// ─── Storyboards ──────────────────────────────────────────────────────────
//
// Storyboards live in their own top-level collection but share one y-doc per
// beat (room: "storyboards:<beatId>"). Scalar text fragments per item:
// "item:<storyboardId>:text_prompt" and ":summary"; plus one fragment per frame
// in the pool: "item:<storyboardId>:frame:<frameId>:prompt". Mutations that
// change room composition (create / delete / reorder storyboards, add / remove
// frames) broadcast a `fields_updated` ping so the SPA refetches and recomposes.

const STORYBOARD_COLLAB_FIELDS = new Set(['text_prompt', 'summary']);

function storyboardItemField(storyboardId, field) {
  return `item:${storyboardId}:${field}`;
}

function framePromptFragment(storyboardId, frameId) {
  return `item:${storyboardId}:frame:${frameId}:prompt`;
}

export async function setStoryboardTextPromptViaGateway({ projectId, storyboardId, text }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  return setEntityFieldMarkdown({
    projectId,
    entityType: 'storyboards',
    entityId: sb.beat_id.toString(),
    field: storyboardItemField(sb._id.toString(), 'text_prompt'),
    markdown: text,
  });
}

export async function setStoryboardSummaryViaGateway({ projectId, storyboardId, text }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  return setEntityFieldMarkdown({
    projectId,
    entityType: 'storyboards',
    entityId: sb.beat_id.toString(),
    field: storyboardItemField(sb._id.toString(), 'summary'),
    markdown: text,
  });
}

export async function setStoryboardFramePromptViaGateway({ projectId, storyboardId, frameId, text }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  if (!(sb.frames || []).some((f) => f._id.toString() === String(frameId))) {
    throw new Error(`frame not found: ${frameId}`);
  }
  return setEntityFieldMarkdown({
    projectId,
    entityType: 'storyboards',
    entityId: sb.beat_id.toString(),
    field: framePromptFragment(sb._id.toString(), String(frameId)),
    markdown: text,
  });
}

export async function createStoryboardViaGateway({
  projectId,
  beatId,
  textPrompt,
  summary = '',
  order,
  seedFragments,
  durationSeconds = null,
  shotType = null,
  transitionIn = null,
  charactersInScene = [],
  reverseInPost = false,
}) {
  const sb = await mongoCreateStoryboard({
    projectId,
    beatId,
    textPrompt,
    summary,
    order,
    durationSeconds,
    shotType,
    transitionIn,
    charactersInScene,
    reverseInPost,
  });
  // Seed the y-doc fragment(s) BEFORE broadcasting the ping. Otherwise the
  // SPA refetches and mounts its CollabField on an empty fragment before the
  // seed write lands, so the user sees an empty editor (and the next
  // onStoreDocument tick clobbers Mongo back to empty).
  if (seedFragments) {
    for (const [key, text] of Object.entries(seedFragments)) {
      if (!STORYBOARD_COLLAB_FIELDS.has(key)) continue;
      try {
        await setEntityFieldMarkdown({
          projectId,
          entityType: 'storyboards',
          entityId: String(beatId),
          field: storyboardItemField(sb._id.toString(), key),
          markdown: text,
        });
      } catch (e) {
        logger.warn(`createStoryboard: seed ${key} failed: ${e.message}`);
      }
    }
  }
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['storyboards'],
    added_storyboard_id: sb._id.toString(),
  });
  return sb;
}

// Persist a shot's critique (prompt_critique or image_critique) and notify the
// storyboards room so connected SPAs re-render the score. target is
// 'prompt' | 'image'. critique is the object from critiquePanel (or null).
export async function setStoryboardCritiqueViaGateway({ projectId, storyboardId, beatId, target, critique }) {
  const field = target === 'image' ? 'image_critique' : 'prompt_critique';
  const updated = await mongoUpdateStoryboard(projectId, String(storyboardId), { [field]: critique });
  try {
    broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
      changed: ['critique'],
      storyboard_id: String(storyboardId),
      critique_target: target,
    });
  } catch (e) {
    logger.warn(`gateway: critique broadcast failed: ${e?.message || e}`);
  }
  return updated;
}

export async function deleteStoryboardViaGateway({ projectId, storyboardId }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beatId = sb.beat_id.toString();
  await mongoDeleteStoryboard(storyboardId);
  // Recompact orders so the remaining items are 1..N-1 contiguous.
  const remaining = await listStoryboards({ projectId, beatId });
  await mongoReorderStoryboards(
    beatId,
    remaining.map((s) => s._id.toString()),
  );
  broadcastFieldsUpdated(buildRoomName('storyboards', beatId), {
    changed: ['storyboards'],
    removed_storyboard_id: String(storyboardId),
  });
  return { ok: true, beat_id: beatId };
}

export async function reorderStoryboardsViaGateway({ projectId, beatId, orderedIds }) {
  const result = await mongoReorderStoryboards(beatId, orderedIds);
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['order'],
  });
  return result;
}

export async function deleteAllStoryboardsForBeatViaGateway({ projectId, beatId }) {
  const removed = await mongoDeleteStoryboardsForBeat(beatId);
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['storyboards'],
    cleared: true,
  });
  return { ok: true, removed_count: removed.length };
}

// "Delete all images" for a beat: clear every frame's generated image (current +
// undo), free the underlying GridFS blobs, and ping the room so SPAs re-render.
// Never deletes a blob still used as a frame reference or as the beat's hero
// image (the codebase "may be shared" guard). Keeps prompts and references.
export async function clearAllFrameImagesForBeatViaGateway({ projectId, beatId }) {
  const { freedImageIds, referencedIds, storyboardIds } =
    await mongoClearAllFrameImagesForBeat(beatId);
  const beat = await getBeat(projectId, beatId);
  const protectedIds = new Set([
    ...referencedIds.map(String),
    ...(beat?.main_image_id ? [String(beat.main_image_id)] : []),
  ]);
  const toDelete = [...new Set(freedImageIds.map(String))].filter(
    (id) => !protectedIds.has(id),
  );
  for (const id of toDelete) {
    await tryDeleteImage(id, 'cleared all storyboard frame images');
  }
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['frames'],
    cleared_images: true,
  });
  return { cleared: storyboardIds.length, freed: toDelete.length };
}

// Broadcast helper: every frame mutation re-renders the whole frame strip on
// connected SPAs, so we ping `frames` rather than enumerating fields.
function broadcastFrames(beatId, storyboardId, extra = {}) {
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['frames'],
    storyboard_id: String(storyboardId),
    ...extra,
  });
}

// Append an image to the frame pool. When the new frame carries a prompt, seed
// its collaborative y-doc fragment BEFORE broadcasting (mirrors
// createStoryboardViaGateway) so the SPA mounts its editor on seeded content.
export async function addStoryboardFrameViaGateway({
  projectId,
  storyboardId,
  imageId = null,
  prompt = '',
  referenceIds = [],
}) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const { storyboard, frameId } = await mongoAddFrame(storyboardId, {
    imageId,
    prompt,
    referenceIds,
  });
  if (prompt) {
    try {
      await setEntityFieldMarkdown({
        projectId,
        entityType: 'storyboards',
        entityId: sb.beat_id.toString(),
        field: framePromptFragment(sb._id.toString(), frameId.toString()),
        markdown: prompt,
      });
    } catch (e) {
      logger.warn(`addStoryboardFrame: seed prompt failed: ${e.message}`);
    }
  }
  broadcastFrames(sb.beat_id, storyboardId, { added_frame_id: frameId.toString() });
  return { storyboard, frameId };
}

// Remove a frame from the pool, deleting any displaced internal undo image.
export async function removeStoryboardFrameViaGateway({ projectId, storyboardId, frameId }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const { storyboard, orphanedImageIds } = await mongoRemoveFrame(storyboardId, frameId);
  for (const oid of orphanedImageIds || []) {
    await tryDeleteImage(oid, 'removed storyboard frame');
  }
  broadcastFrames(sb.beat_id, storyboardId, { removed_frame_id: String(frameId) });
  return storyboard;
}

export async function reorderStoryboardFramesViaGateway({ projectId, storyboardId, orderedFrameIds }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const next = await mongoReorderFrames(storyboardId, orderedFrameIds);
  broadcastFrames(sb.beat_id, storyboardId);
  return next;
}

// Install (or clear) the current image of an existing frame — used by the
// "Replace" action and single-image install from the Add Frame picker.
export async function setStoryboardFrameImageViaGateway({ projectId, storyboardId, frameId, imageId }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const next = await mongoSetFrameImage(storyboardId, frameId, imageId);
  broadcastFrames(sb.beat_id, storyboardId, { frame_id: String(frameId) });
  return next;
}

// Edit-flow persistence: current → previous, new becomes current, the old
// previous is deleted from GridFS. Mirrors setArtworkResultViaGateway with
// rotateToPrevious=true. Broadcasts a fields_updated ping so connected SPAs
// re-render with the new image and undo-availability state.
export async function setStoryboardFrameEditResultViaGateway({
  storyboardId,
  frameId,
  newImageId,
  editPrompt,
}) {
  const result = await mongoRotateFrameImageEdit({
    id: storyboardId,
    frameId,
    newImageId,
    editPrompt,
  });
  await tryDeleteImage(result.orphanedImageId, 'orphaned storyboard frame');
  broadcastFrames(result.storyboard.beat_id, storyboardId, { frame_id: String(frameId) });
  return result.storyboard;
}

// Undo the last frame edit: previous → current, clears the previous and the
// last edit prompt. The image that was current is deleted from GridFS.
export async function undoStoryboardFrameEditViaGateway({ storyboardId, frameId }) {
  const result = await mongoUndoFrameImageEdit({ id: storyboardId, frameId });
  await tryDeleteImage(result.orphanedImageId, 'undone storyboard frame');
  broadcastFrames(result.storyboard.beat_id, storyboardId, { frame_id: String(frameId) });
  return result.storyboard;
}

// PATCH-style scalar update for the SPA's editable shot metadata. Validates
// each field via mongoUpdateStoryboard's existing rules (clamp + warn for
// duration, throw on bad shot_type, trim characters_in_scene). Broadcasts a
// fields_updated ping so other connected SPA tabs refresh.
const STORYBOARD_SCALAR_FIELDS = new Set([
  'duration_seconds',
  'shot_type',
  'transition_in',
  'characters_in_scene',
]);

export async function updateStoryboardScalarsViaGateway({ projectId, storyboardId, patch }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const filtered = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (STORYBOARD_SCALAR_FIELDS.has(k)) filtered[k] = v;
  }
  if (!Object.keys(filtered).length) {
    throw new Error('updateStoryboardScalars: no recognized fields');
  }
  const result = await mongoUpdateStoryboard(projectId, storyboardId, filtered);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: Object.keys(filtered),
    storyboard_id: String(storyboardId),
  });
  return result;
}

export async function addStoryboardFrameReferenceImageViaGateway({
  projectId,
  storyboardId,
  frameId,
  imageId,
}) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const next = await mongoPushFrameReferenceImage(storyboardId, frameId, imageId);
  broadcastFrames(sb.beat_id, storyboardId, { frame_id: String(frameId) });
  return next;
}

export async function removeStoryboardFrameReferenceImageViaGateway({
  projectId,
  storyboardId,
  frameId,
  imageId,
}) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const next = await mongoPullFrameReferenceImage(storyboardId, frameId, imageId);
  broadcastFrames(sb.beat_id, storyboardId, { frame_id: String(frameId) });
  return next;
}

// Batch helper for a single frame's reference list: append-many or
// replace-the-whole-list. Exactly one fields_updated broadcast fires per call,
// used by the auto-suggest endpoint and the multi-select picker's Apply.
export async function setStoryboardFrameReferenceImagesViaGateway({
  projectId,
  storyboardId,
  frameId,
  imageIds,
  mode = 'replace',
}) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const ids = Array.isArray(imageIds) ? imageIds : [];
  let next;
  if (mode === 'append') {
    next = await mongoPushFrameReferenceImages(storyboardId, frameId, ids);
  } else if (mode === 'replace') {
    next = await mongoSetFrameReferenceImages(storyboardId, frameId, ids);
  } else {
    throw new Error(`setStoryboardFrameReferenceImagesViaGateway: invalid mode ${mode}`);
  }
  broadcastFrames(sb.beat_id, storyboardId, { frame_id: String(frameId) });
  return next;
}

export async function setStoryboardAudioViaGateway({ projectId, storyboardId, audioFileId }) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const patch = {
    audio_file_id: audioFileId == null ? null : String(audioFileId),
  };
  // Probe the attached audio's duration so lip-sync cost estimates can
  // render without a round-trip to fal. Failures (corrupt headers,
  // unsupported codec) log+null — the cost UI degrades gracefully.
  if (audioFileId == null) {
    patch.audio_duration_seconds = null;
  } else {
    try {
      const read = await readAttachmentBuffer(audioFileId);
      if (read?.buffer) {
        const mime =
          read.file?.contentType || read.file?.metadata?.content_type || null;
        const dur = await probeAudioDurationSeconds(read.buffer, mime);
        patch.audio_duration_seconds = dur || null;
      } else {
        patch.audio_duration_seconds = null;
      }
    } catch (e) {
      logger.warn(`gateway: audio duration probe failed for ${audioFileId}: ${e.message}`);
      patch.audio_duration_seconds = null;
    }
  }
  await mongoUpdateStoryboard(projectId, storyboardId, patch);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: Object.keys(patch),
    storyboard_id: String(storyboardId),
  });
  return mongoGetStoryboard(projectId, storyboardId);
}

// Attach a user-uploaded source video to a storyboard. This is the input
// side of video-to-video models — distinct from `video_file_id`, which is
// reserved for the MP4 generated by fal. Pass videoFileId=null to clear.
// Duration is probed via the same music-metadata helper that handles audio
// (works for MP4 containers); failures fall back to null.
export async function setStoryboardUploadedVideoViaGateway({
  projectId,
  storyboardId,
  videoFileId,
}) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const patch = {
    video_upload_file_id: videoFileId == null ? null : String(videoFileId),
  };
  if (videoFileId == null) {
    patch.video_upload_duration_seconds = null;
  } else {
    try {
      const read = await readAttachmentBuffer(videoFileId);
      if (read?.buffer) {
        const mime =
          read.file?.contentType || read.file?.metadata?.content_type || null;
        const dur = await probeAudioDurationSeconds(read.buffer, mime);
        patch.video_upload_duration_seconds = dur || null;
      } else {
        patch.video_upload_duration_seconds = null;
      }
    } catch (e) {
      logger.warn(
        `gateway: uploaded video duration probe failed for ${videoFileId}: ${e.message}`,
      );
      patch.video_upload_duration_seconds = null;
    }
  }
  await mongoUpdateStoryboard(projectId, storyboardId, patch);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: Object.keys(patch),
    storyboard_id: String(storyboardId),
  });
  return mongoGetStoryboard(projectId, storyboardId);
}

// Attach a generated video to a storyboard. Used by the fal.ai video
// pipeline after it downloads the MP4 into our GridFS attachments bucket.
// Pass videoFileId=null to clear the slot. durationSeconds (when known) is
// the actual MP4 duration the inline player uses for its timeline. The
// model metadata (id/label/lab/family/added_at/falModel), input
// `parameters`, and `costUsd` are surfaced under the inline player so the
// user can tell at a glance which model rendered the clip, with what
// arguments, and at what cost.
export async function setStoryboardVideoViaGateway({
  projectId,
  storyboardId,
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
}) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
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
    if (modelAddedAt != null) {
      const d = modelAddedAt instanceof Date ? modelAddedAt : new Date(modelAddedAt);
      patch.video_model_added_at = Number.isNaN(d.getTime()) ? null : d;
    } else {
      patch.video_model_added_at = null;
    }
    patch.video_parameters =
      parameters && typeof parameters === 'object' && !Array.isArray(parameters)
        ? parameters
        : null;
    patch.video_cost_usd =
      typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
        ? costUsd
        : null;
  }
  await mongoUpdateStoryboard(projectId, storyboardId, patch);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: Object.keys(patch),
    storyboard_id: String(storyboardId),
  });
  return mongoGetStoryboard(projectId, storyboardId);
}

// Copy an existing GridFS attachment (e.g. one attached to a beat or
// character) into a fresh file owned by the storyboard's beat, then point the
// storyboard's audio_file_id or video_upload_file_id at the new file. Source
// and destination end up holding independent copies — deleting or replacing
// one does not affect the other. `kind` is 'audio' or 'video'; the source
// attachment's content_type must match the kind.
export async function copyAttachmentToStoryboardMediaViaGateway({
  projectId,
  storyboardId,
  attachmentId,
  kind,
}) {
  if (kind !== 'audio' && kind !== 'video') {
    throw new Error(`copyAttachmentToStoryboardMediaViaGateway: invalid kind ${kind}`);
  }
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const source = await findAttachmentFile(attachmentId);
  if (!source) throw new Error(`Attachment not found: ${attachmentId}`);
  const sourceCt =
    source.contentType || source.metadata?.content_type || '';
  const expectedPrefix = kind === 'audio' ? 'audio/' : 'video/';
  if (!sourceCt.startsWith(expectedPrefix)) {
    throw new Error(
      `Attachment ${attachmentId} content type "${sourceCt}" is not ${expectedPrefix}*`,
    );
  }
  const newFile = await copyAttachmentBuffer({
    sourceFileId: attachmentId,
    filename: source.filename || `scene-${storyboardId}-${kind}-${Date.now()}`,
    ownerType: 'beat',
    ownerId: sb.beat_id,
  });
  const storyboard =
    kind === 'audio'
      ? await setStoryboardAudioViaGateway({
          projectId,
          storyboardId,
          audioFileId: newFile._id,
        })
      : await setStoryboardUploadedVideoViaGateway({
          projectId,
          storyboardId,
          videoFileId: newFile._id,
        });
  return {
    storyboard,
    [kind]: {
      _id: newFile._id,
      filename: newFile.filename,
      content_type: newFile.content_type,
      size: newFile.size,
    },
  };
}

// Copy a dialog item's audio bytes into a fresh GridFS file owned by the
// target storyboard, then point the storyboard's audio_file_id at the new
// file. The dialog and storyboard end up holding independent copies — deleting
// or replacing one does not affect the other.
export async function copyDialogAudioToStoryboardViaGateway({
  projectId,
  storyboardId,
  dialogId,
}) {
  const sb = await mongoGetStoryboard(projectId, storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const d = await mongoGetDialog(projectId, dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  if (!d.audio_file_id) {
    throw new Error(`Dialog ${dialogId} has no audio to copy.`);
  }
  if (sb.beat_id.toString() !== d.beat_id.toString()) {
    throw new Error(
      `Dialog ${dialogId} and storyboard ${storyboardId} belong to different beats.`,
    );
  }
  const newFile = await copyAttachmentBuffer({
    sourceFileId: d.audio_file_id,
    filename: `scene-${storyboardId}-audio-${Date.now()}`,
    ownerType: 'beat',
    ownerId: sb.beat_id,
  });
  const storyboard = await setStoryboardAudioViaGateway({
    projectId,
    storyboardId,
    audioFileId: newFile._id,
  });
  return {
    storyboard,
    audio: {
      _id: newFile._id,
      filename: newFile.filename,
      content_type: newFile.content_type,
      size: newFile.size,
    },
  };
}

// ─── Dialogs ──────────────────────────────────────────────────────────────
//
// Dialogs live in their own top-level collection but share one y-doc per
// beat (room: "dialogs:<beatId>") with two fragments per item:
// "item:<dialogId>:body" and "item:<dialogId>:character". Mutations that
// change room composition (create / delete / reorder) broadcast a
// `fields_updated` ping to the room so the SPA refetches.

function dialogItemField(dialogId, field) {
  return `item:${dialogId}:${field}`;
}

const DIALOG_TEXT_FIELDS = new Set(['body', 'character']);

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
  const d = await mongoCreateDialog({ projectId, beatId, body, character, order });
  // Seed body / character y-doc fragments BEFORE broadcasting the ping (see
  // createStoryboardViaGateway for the same reasoning). Without this, the
  // SPA's CollabField for the new dialog mounts against an empty fragment
  // and shows a blank body until the user reloads.
  if (seedFragments) {
    for (const [field, text] of Object.entries(seedFragments)) {
      if (!DIALOG_TEXT_FIELDS.has(field)) continue;
      try {
        await setEntityFieldMarkdown({
          projectId,
          entityType: 'dialogs',
          entityId: String(beatId),
          field: dialogItemField(d._id.toString(), field),
          markdown: text,
        });
      } catch (e) {
        logger.warn(`createDialog: seed ${field} failed: ${e.message}`);
      }
    }
  }
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

// Attach or detach a dialog item's recorded audio file. Pass `audioFileId:
// null` to unlink (the GridFS bytes are left in place, mirroring the
// storyboard-audio convention).
export async function setDialogAudioViaGateway({ projectId, dialogId, audioFileId }) {
  const d = await mongoGetDialog(projectId, dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  await mongoUpdateDialog(projectId, dialogId, {
    audio_file_id: audioFileId == null ? null : String(audioFileId),
  });
  broadcastFieldsUpdated(buildRoomName('dialogs', d.beat_id.toString()), {
    changed: ['audio_file_id'],
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
  if (ownerType !== 'beat' && ownerType !== 'character') {
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
  await withDirectDocument(roomName, { actor: 'bot' }, (document) => {
    out = fragmentToMarkdown(document, field);
  });
  return out;
}
