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
  appendCharacterSheetImage,
  removeCharacterSheetImage,
  reorderCharacterSheetImages,
} from '../mongo/characters.js';
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
  deleteStoryboard as mongoDeleteStoryboard,
  deleteStoryboardsForBeat as mongoDeleteStoryboardsForBeat,
  getStoryboard as mongoGetStoryboard,
  reorderStoryboardsForBeat as mongoReorderStoryboards,
  pushReferenceImage as mongoPushReferenceImage,
  pullReferenceImage as mongoPullReferenceImage,
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
import {
  setLibraryAttachmentMeta,
  setOwnedAttachmentMeta,
  findAttachmentFile,
  copyAttachmentBuffer,
  attachExistingAttachmentToBeat,
  attachExistingAttachmentToCharacter,
  attachExistingAttachmentToDirectorNote,
} from '../mongo/attachments.js';
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

async function readEntityField({ entityType, entityId, field }) {
  if (entityType === 'beat') {
    const beat = await getBeat(entityId);
    if (!beat) throw new Error(`Beat not found: ${entityId}`);
    if (field === 'body') return String(beat.body || '');
    if (field === 'name') return String(beat.name || '');
    if (field === 'desc') return String(beat.desc || '');
    if (field.startsWith('specifics.')) {
      const v = beat.specifics?.[field.slice('specifics.'.length)];
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
    throw new Error(`gateway fallback: unknown beat field "${field}"`);
  }
  if (entityType === 'character') {
    const c = await getCharacter(entityId);
    if (!c) throw new Error(`Character not found: ${entityId}`);
    if (field === 'name') return String(c.name || '');
    if (field === 'hollywood_actor') return String(c.hollywood_actor || '');
    if (field.startsWith('fields.')) {
      const v = c.fields?.[field.slice('fields.'.length)];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    if (field.startsWith('specifics.')) {
      const v = c.specifics?.[field.slice('specifics.'.length)];
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
    const doc = await getDirectorNotes();
    const note = (doc.notes || []).find((n) => n._id?.toString?.() === String(noteId));
    if (!note) throw new Error(`Director's note not found: ${noteId}`);
    return String(note.text || '');
  }
  if (entityType === 'storyboards') {
    const m = field.match(/^item:([a-f0-9]{24}):text_prompt$/);
    if (!m) throw new Error(`gateway fallback: unknown storyboards field "${field}"`);
    const sb = await mongoGetStoryboard(m[1]);
    if (!sb) throw new Error(`Storyboard not found: ${m[1]}`);
    return String(sb.text_prompt || '');
  }
  if (entityType === 'dialogs') {
    const m = field.match(/^item:([a-f0-9]{24}):(body|character)$/);
    if (!m) throw new Error(`gateway fallback: unknown dialogs field "${field}"`);
    const d = await mongoGetDialog(m[1]);
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

async function fallbackTextWrite({ entityType, entityId, field, op, ...args }) {
  if (entityType === 'beat' && field === 'body') {
    if (op === 'set') return Plots.setBeatBody(entityId, args.markdown);
    if (op === 'edit') return Plots.editBeatBody(entityId, args.edits);
    if (op === 'append') return Plots.appendBeatBody(entityId, args.content);
  }

  if (op === 'edit') {
    const { applyMarkdownEdits } = await import('../util/textWindow.js');
    const current = await readEntityField({ entityType, entityId, field });
    const result = applyMarkdownEdits(current, args.edits, 'edit_field');
    await fallbackTextWrite({ entityType, entityId, field, op: 'set', markdown: result.body });
    return {
      edits: result.applied,
      beforeLen: result.beforeLen,
      afterLen: result.afterLen,
      value: result.body,
    };
  }

  if (op === 'append') {
    const current = await readEntityField({ entityType, entityId, field });
    const addition = String(args.content ?? '').trim();
    if (!addition) throw new Error('No content to append.');
    const sep = current.trim() ? '\n\n' : '';
    const next = `${current}${sep}${addition}`;
    await fallbackTextWrite({ entityType, entityId, field, op: 'set', markdown: next });
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
    return Plots.updateBeat(entityId, { [field]: args.markdown });
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
      return updateCharacter(entityId, { [field]: args.markdown });
    }
    if (field.startsWith('fields.') || field.startsWith('specifics.')) {
      return updateCharacter(entityId, { [field]: args.markdown });
    }
  }
  if (entityType === 'notes' && field.startsWith('note:') && field.endsWith(':text')) {
    const noteId = field.slice('note:'.length, -':text'.length);
    const { editDirectorNote } = await import('../mongo/directorNotes.js');
    return editDirectorNote({ noteId, text: args.markdown });
  }
  if (entityType === 'storyboards') {
    const m = field.match(/^item:([a-f0-9]{24}):text_prompt$/);
    if (!m) throw new Error(`gateway fallback: unknown storyboards field "${field}"`);
    return mongoUpdateStoryboard(m[1], { text_prompt: args.markdown });
  }
  if (entityType === 'dialogs') {
    const m = field.match(/^item:([a-f0-9]{24}):(body|character)$/);
    if (!m) throw new Error(`gateway fallback: unknown dialogs field "${field}"`);
    return mongoUpdateDialog(m[1], { [m[2]]: args.markdown });
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

export async function setEntityFieldMarkdown({ entityType, entityId, field, markdown }) {
  if (!isHocuspocusRunning()) {
    await fallbackTextWrite({ entityType, entityId, field, op: 'set', markdown });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return;
  }
  const { setFragmentMarkdown } = await he();
  const roomName = buildRoomName(entityType, entityId);
  await withDirectDocument(roomName, { actor: 'bot' }, (document) => {
    withBotPresence(roomName, field, () => {
      setFragmentMarkdown(document, field, String(markdown ?? ''));
    });
  });
  logger.info(
    `gateway: set ${entityType}/${entityId}/${field} chars=${String(markdown ?? '').length}`,
  );
}

export async function editEntityFieldMarkdown({ entityType, entityId, field, edits }) {
  if (!isHocuspocusRunning()) {
    const result = await fallbackTextWrite({ entityType, entityId, field, op: 'edit', edits });
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
  const roomName = buildRoomName(entityType, entityId);
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

export async function appendEntityFieldMarkdown({ entityType, entityId, field, content }) {
  if (!isHocuspocusRunning()) {
    const result = await fallbackTextWrite({ entityType, entityId, field, op: 'append', content });
    enqueueRagAfterFallback({ entityType, entityId, field });
    return result?.body ?? '';
  }
  const { appendToFragmentMarkdown } = await he();
  const roomName = buildRoomName(entityType, entityId);
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

export async function setBeatBodyViaGateway(beatId, body) {
  return setEntityFieldMarkdown({
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    markdown: body,
  });
}

export async function editBeatBodyViaGateway(beatId, edits) {
  return editEntityFieldMarkdown({
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    edits,
  });
}

export async function appendBeatBodyViaGateway(beatId, content) {
  return appendEntityFieldMarkdown({
    entityType: 'beat',
    entityId: String(beatId),
    field: 'body',
    content,
  });
}

// updateBeat may include text fields (name/desc/body, specifics.*) and order
// /characters/scene_sheet_image_id; route text fields through the gateway and
// the rest through Mongo.
export async function updateBeatViaGateway(identifier, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_beat: \`patch\` must be an object like {body: "..."}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }. Wrap your fields in {patch: {body: "..."}} (or name/desc/order/characters).`,
    );
  }
  const isRecognizedKey = (k) =>
    k === 'name' ||
    k === 'desc' ||
    k === 'body' ||
    k === 'order' ||
    k === 'characters' ||
    k === 'specifics' ||
    k.startsWith('specifics.') ||
    k === 'scene_sheet_image_id';
  if (!Object.keys(patch).some((k) => isRecognizedKey(k) && patch[k] !== undefined)) {
    throw new Error(
      `update_beat: \`patch\` has no recognized fields. Expected one of: name, desc, body, order, characters, specifics, specifics.<key>, scene_sheet_image_id. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const beat = await getBeat(identifier);
  if (!beat) throw new Error(`Beat not found: ${identifier}`);
  const beatId = beat._id.toString();
  if (patch.name !== undefined) {
    await setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: beatId,
      field: 'name',
      markdown: patch.name,
    });
  }
  if (patch.desc !== undefined) {
    await setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: beatId,
      field: 'desc',
      markdown: patch.desc,
    });
  }
  if (patch.body !== undefined) {
    await setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: beatId,
      field: 'body',
      markdown: patch.body,
    });
  }
  if (patch.specifics !== undefined && patch.specifics && typeof patch.specifics === 'object') {
    for (const [sk, sv] of Object.entries(patch.specifics)) {
      await setEntityFieldMarkdown({
        entityType: 'beat',
        entityId: beatId,
        field: `specifics.${sk}`,
        markdown: sv,
      });
    }
  }
  for (const k of Object.keys(patch)) {
    if (k.startsWith('specifics.')) {
      await setEntityFieldMarkdown({
        entityType: 'beat',
        entityId: beatId,
        field: k,
        markdown: patch[k],
      });
    }
  }
  // order, characters, and scene_sheet_image_id are non-text → hit Mongo directly.
  const onlyDiscrete = {};
  if (patch.order !== undefined) onlyDiscrete.order = patch.order;
  if (Array.isArray(patch.characters)) onlyDiscrete.characters = patch.characters;
  if (Object.prototype.hasOwnProperty.call(patch, 'scene_sheet_image_id')) {
    onlyDiscrete.scene_sheet_image_id = patch.scene_sheet_image_id;
  }
  if (Object.keys(onlyDiscrete).length) {
    const { updateBeat: mongoUpdateBeat } = await import('../mongo/plots.js');
    await mongoUpdateBeat(beatId, onlyDiscrete);
    broadcastFieldsUpdated(buildRoomName('beat', beatId), {
      changed: Object.keys(onlyDiscrete),
    });
  }
  return getBeat(beatId);
}

export async function updateCharacterViaGateway(identifier, patch) {
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
      k === 'specifics' ||
      k.startsWith('specifics.') ||
      k === 'plays_self' ||
      k === 'hollywood_actor' ||
      k === 'own_voice' ||
      k === 'unset',
  );
  if (!recognized) {
    throw new Error(
      `update_character: \`patch\` has no recognized fields. Expected name, fields, fields.<key>, specifics, specifics.<key>, plays_self, hollywood_actor, own_voice, or unset. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const c = await getCharacter(identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const cid = c._id.toString();
  // Split text fields (name, hollywood_actor, fields.*, specifics.*) from
  // discrete fields (plays_self, own_voice) and `unset`.
  const textOps = [];
  const discrete = {};
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
    } else if (k === 'specifics' && v && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        textOps.push({ field: `specifics.${sk}`, markdown: sv });
      }
    } else if (k.startsWith('specifics.')) {
      textOps.push({ field: k, markdown: v });
    } else if (k === 'plays_self' || k === 'own_voice') {
      discrete[k] = v;
    } else if (k === 'unset') {
      unset = v;
    }
  }
  for (const { field, markdown } of textOps) {
    await setEntityFieldMarkdown({
      entityType: 'character',
      entityId: cid,
      field,
      markdown,
    });
  }
  if (Object.keys(discrete).length || unset) {
    const mongoPatch = { ...discrete };
    if (unset) mongoPatch.unset = unset;
    await mongoUpdateCharacter(cid, mongoPatch);
    broadcastFieldsUpdated(buildRoomName('character', cid), {
      changed: [...Object.keys(discrete), ...(unset || []).map((u) => `-fields.${u}`)],
    });
  }
  return getCharacter(cid);
}

export async function editDirectorNoteViaGateway({ noteId, text }) {
  return setEntityFieldMarkdown({
    entityType: 'notes',
    entityId: 'notes',
    field: `note:${String(noteId)}:text`,
    markdown: text,
  });
}

export async function editDirectorNoteTextViaGateway({ noteId, edits }) {
  return editEntityFieldMarkdown({
    entityType: 'notes',
    entityId: 'notes',
    field: `note:${String(noteId)}:text`,
    edits,
  });
}

export async function editCharacterFieldViaGateway({ identifier, field, edits }) {
  const c = await getCharacter(identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  return editEntityFieldMarkdown({
    entityType: 'character',
    entityId: c._id.toString(),
    field,
    edits,
  });
}

export async function addDirectorNoteViaGateway({ text, position }) {
  // Add the note in Mongo (it gets a fresh _id), then ping the room so the
  // /notes page renders the new editor for its text fragment. The fragment
  // itself will be seeded from the just-written `text` on first connection.
  const note = await mongoAddDirectorNote({ text, position });
  broadcastFieldsUpdated('notes', {
    changed: ['notes'],
    added_note_id: note._id.toString(),
  });
  enqueueReindex('director_note', note._id.toString());
  return note;
}

export async function removeDirectorNoteViaGateway({ noteId }) {
  await mongoRemoveDirectorNote({ noteId });
  broadcastFieldsUpdated('notes', {
    changed: ['notes'],
    removed_note_id: String(noteId),
  });
  // Immediate delete so stale chunks don't linger in retrieval.
  deleteEntity('director_note', String(noteId)).catch(() => {});
}

// ─── Non-text mutations ────────────────────────────────────────────────────

export async function addBeatImageViaGateway({ beatId, imageMeta, setAsMain }) {
  const result = await pushBeatImage(String(beatId), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function removeBeatImageViaGateway({ beatId, imageId }) {
  const result = await pullBeatImage(String(beatId), imageId);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function setBeatMainImageViaGateway({ beatId, imageId }) {
  const result = await setBeatMainImage(String(beatId), imageId);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['main_image_id'],
  });
  return result;
}

export async function addBeatAttachmentViaGateway({ beatId, attachmentMeta }) {
  const result = await pushBeatAttachment(String(beatId), attachmentMeta);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['attachments'],
  });
  return result;
}

export async function removeBeatAttachmentViaGateway({ beatId, attachmentId }) {
  const result = await pullBeatAttachment(String(beatId), attachmentId);
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['attachments'],
  });
  return result;
}

export async function setBeatSceneSheetImageViaGateway({ beatId, imageId }) {
  const beat = await getBeat(String(beatId));
  if (!beat) throw new Error(`Beat not found: ${beatId}`);
  const id = beat._id.toString();
  await Plots.updateBeat(id, {
    scene_sheet_image_id: imageId == null ? null : String(imageId),
  });
  broadcastFieldsUpdated(buildRoomName('beat', id), {
    changed: ['scene_sheet_image_id'],
  });
  return getBeat(id);
}

export async function addCharacterImageViaGateway({ character, imageMeta, setAsMain }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await pushCharacterImage(c._id.toString(), imageMeta, !!setAsMain);
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

export async function setCharacterMainImageViaGateway({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await setMainCharacterImage({ character: c._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['main_image_id'],
  });
  return result;
}

export async function removeCharacterImageViaGateway({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await removeCharacterImage({ character: c._id.toString(), imageId });
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  return result;
}

// Replace a beat's image with a new one at the same slot position. Caller
// has already uploaded `newImageMeta` to GridFS; this helper swaps the meta
// inside beat.images[], updates main_image_id when applicable, deletes the
// old GridFS bytes, then broadcasts to the room.
export async function replaceBeatImageViaGateway({ beatId, oldImageId, newImageMeta }) {
  const result = await replaceBeatImage(String(beatId), oldImageId, newImageMeta);
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

export async function replaceCharacterImageViaGateway({ character, oldImageId, newImageMeta }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const cid = c._id.toString();
  const result = await replaceCharacterImage(cid, oldImageId, newImageMeta);
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
function broadcastPriorImageOwner(movedFrom) {
  if (!movedFrom) {
    broadcastFieldsUpdated('library', { changed: ['library_images'] });
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
    broadcastFieldsUpdated('notes', {
      changed: [
        `note:${movedFrom.prior_owner_id}:images`,
        `note:${movedFrom.prior_owner_id}:main_image_id`,
      ],
      note_id: String(movedFrom.prior_owner_id),
    });
  }
}

function broadcastPriorAttachmentOwner(movedFrom) {
  if (!movedFrom) {
    broadcastFieldsUpdated('library', { changed: ['library_attachments'] });
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
    broadcastFieldsUpdated('notes', {
      changed: [`note:${movedFrom.prior_owner_id}:attachments`],
      note_id: String(movedFrom.prior_owner_id),
    });
  }
}

// Attach an already-uploaded GridFS image to a beat's gallery. The image's
// current owner is detached first (library or another entity), then ownership
// is reassigned and beat.images[] gets a new entry. Both rooms broadcast.
export async function attachExistingImageToBeatViaGateway({
  beatId,
  imageId,
  setAsMain = false,
}) {
  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);
  const targetBeat = await getBeat(String(beatId));
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
    targetBeat._id.toString(),
    meta,
    !!setAsMain,
  );
  broadcastFieldsUpdated(
    buildRoomName('beat', targetBeat._id.toString()),
    { changed: ['images', 'main_image_id'] },
  );
  broadcastPriorImageOwner(movedFrom);
  return result;
}

export async function attachExistingImageToCharacterViaGateway({
  character,
  imageId,
  setAsMain = false,
}) {
  const c = await getCharacter(character);
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
    c._id.toString(),
    meta,
    !!setAsMain,
  );
  broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
    changed: ['images', 'main_image_id'],
  });
  broadcastPriorImageOwner(movedFrom);
  return result;
}

export async function attachExistingImageToDirectorNoteViaGateway({
  noteId,
  imageId,
  setAsMain = false,
}) {
  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);
  const { notes = [] } = (await getDirectorNotes()) || {};
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
    target._id.toString(),
    meta,
    !!setAsMain,
  );
  broadcastFieldsUpdated('notes', {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  broadcastPriorImageOwner(movedFrom);
  return result;
}

export async function attachExistingAttachmentToBeatViaGateway({
  beatId,
  attachmentId,
}) {
  const result = await attachExistingAttachmentToBeat({
    beat: String(beatId),
    attachmentId,
  });
  if (!result?.already_attached) {
    broadcastFieldsUpdated(
      buildRoomName('beat', String(result?.beat?._id || beatId)),
      { changed: ['attachments'] },
    );
    broadcastPriorAttachmentOwner(result?.moved_from);
  }
  return result;
}

export async function attachExistingAttachmentToCharacterViaGateway({
  character,
  attachmentId,
}) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const result = await attachExistingAttachmentToCharacter({
    character: c._id.toString(),
    attachmentId,
  });
  if (!result?.already_attached) {
    broadcastFieldsUpdated(buildRoomName('character', c._id.toString()), {
      changed: ['attachments'],
    });
    broadcastPriorAttachmentOwner(result?.moved_from);
  }
  return result;
}

export async function attachExistingAttachmentToDirectorNoteViaGateway({
  noteId,
  attachmentId,
}) {
  const result = await attachExistingAttachmentToDirectorNote({
    noteId: String(noteId),
    attachmentId,
  });
  if (!result?.already_attached) {
    broadcastFieldsUpdated('notes', {
      changed: [`note:${noteId}:attachments`],
      note_id: String(noteId),
    });
    broadcastPriorAttachmentOwner(result?.moved_from);
  }
  return result;
}

export async function moveBeatImageToLibraryViaGateway({ beatId, imageId }) {
  const result = await pullBeatImage(String(beatId), imageId);
  await setImageOwner(imageId, { ownerType: null, ownerId: null });
  broadcastFieldsUpdated(buildRoomName('beat', String(beatId)), {
    changed: ['images', 'main_image_id'],
  });
  broadcastFieldsUpdated('library', {
    changed: ['library_images'],
    added_image_id: String(imageId),
  });
  return result;
}

export async function moveCharacterImageToLibraryViaGateway({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const cid = c._id.toString();
  const result = await pullCharacterImage(cid, imageId);
  await setImageOwner(imageId, { ownerType: null, ownerId: null });
  broadcastFieldsUpdated(buildRoomName('character', cid), {
    changed: ['images', 'main_image_id'],
  });
  broadcastFieldsUpdated('library', {
    changed: ['library_images'],
    added_image_id: String(imageId),
  });
  return result;
}

export async function moveDirectorNoteImageToLibraryViaGateway({ noteId, imageId }) {
  const result = await pullDirectorNoteImage(String(noteId), imageId);
  await setImageOwner(imageId, { ownerType: null, ownerId: null });
  broadcastFieldsUpdated('notes', {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  broadcastFieldsUpdated('library', {
    changed: ['library_images'],
    added_image_id: String(imageId),
  });
  return result;
}

export async function appendCharacterSheetImageViaGateway({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const cid = c._id.toString();
  const result = await appendCharacterSheetImage(cid, imageId);
  broadcastFieldsUpdated(buildRoomName('character', cid), {
    changed: ['character_sheet_image_ids'],
  });
  return result;
}

export async function removeCharacterSheetImageViaGateway({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const cid = c._id.toString();
  const result = await removeCharacterSheetImage(cid, imageId);
  // Drop the underlying GridFS bytes — the sheet is owned by this character.
  try {
    await deleteImage(imageId);
  } catch (e) {
    logger.warn(`gateway: delete sheet image ${imageId} failed: ${e.message}`);
  }
  broadcastFieldsUpdated(buildRoomName('character', cid), {
    changed: ['character_sheet_image_ids'],
  });
  return result;
}

export async function reorderCharacterSheetImagesViaGateway({ character, orderedIds }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const cid = c._id.toString();
  const result = await reorderCharacterSheetImages(cid, orderedIds);
  broadcastFieldsUpdated(buildRoomName('character', cid), {
    changed: ['character_sheet_image_ids'],
  });
  return result;
}

export async function addDirectorNoteImageViaGateway({ noteId, imageMeta, setAsMain }) {
  const result = await pushDirectorNoteImage(String(noteId), imageMeta, !!setAsMain);
  broadcastFieldsUpdated('notes', {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  return result;
}

export async function removeDirectorNoteImageViaGateway({ noteId, imageId }) {
  const result = await pullDirectorNoteImage(String(noteId), imageId);
  broadcastFieldsUpdated('notes', {
    changed: [`note:${noteId}:images`, `note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  return result;
}

export async function setDirectorNoteMainImageViaGateway({ noteId, imageId }) {
  const result = await setDirectorNoteMainImage(String(noteId), imageId);
  broadcastFieldsUpdated('notes', {
    changed: [`note:${noteId}:main_image_id`],
    note_id: String(noteId),
  });
  return result;
}

export async function addDirectorNoteAttachmentViaGateway({ noteId, attachmentMeta }) {
  const result = await pushDirectorNoteAttachment(String(noteId), attachmentMeta);
  broadcastFieldsUpdated('notes', {
    changed: [`note:${noteId}:attachments`],
    note_id: String(noteId),
  });
  return result;
}

export async function removeDirectorNoteAttachmentViaGateway({ noteId, attachmentId }) {
  const result = await pullDirectorNoteAttachment(String(noteId), attachmentId);
  broadcastFieldsUpdated('notes', {
    changed: [`note:${noteId}:attachments`],
    note_id: String(noteId),
  });
  return result;
}

// ─── Storyboards ──────────────────────────────────────────────────────────
//
// Storyboards live in their own top-level collection but share one y-doc per
// beat (room: "storyboards:<beatId>") with a fragment per item:
// "item:<storyboardId>:text_prompt". Mutations that change room composition
// (create / delete / reorder) broadcast a `fields_updated` ping to the room
// so the SPA refetches.

function storyboardItemField(storyboardId) {
  return `item:${storyboardId}:text_prompt`;
}

export async function setStoryboardTextPromptViaGateway({ storyboardId, text }) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  return setEntityFieldMarkdown({
    entityType: 'storyboards',
    entityId: sb.beat_id.toString(),
    field: storyboardItemField(sb._id.toString()),
    markdown: text,
  });
}

export async function createStoryboardViaGateway({
  beatId,
  textPrompt,
  order,
  seedFragments,
  durationSeconds = null,
  shotType = null,
  transitionIn = null,
  charactersInScene = [],
}) {
  const sb = await mongoCreateStoryboard({
    beatId,
    textPrompt,
    order,
    durationSeconds,
    shotType,
    transitionIn,
    charactersInScene,
  });
  // Seed the y-doc fragment(s) BEFORE broadcasting the ping. Otherwise the
  // SPA refetches and mounts its CollabField on an empty fragment before the
  // seed write lands, so the user sees an empty editor (and the next
  // onStoreDocument tick clobbers Mongo back to empty).
  if (seedFragments) {
    for (const [key, text] of Object.entries(seedFragments)) {
      if (key !== 'text_prompt') continue;
      try {
        await setEntityFieldMarkdown({
          entityType: 'storyboards',
          entityId: String(beatId),
          field: storyboardItemField(sb._id.toString()),
          markdown: text,
        });
      } catch (e) {
        logger.warn(`createStoryboard: seed text_prompt failed: ${e.message}`);
      }
    }
  }
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['storyboards'],
    added_storyboard_id: sb._id.toString(),
  });
  return sb;
}

export async function deleteStoryboardViaGateway({ storyboardId }) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const beatId = sb.beat_id.toString();
  await mongoDeleteStoryboard(storyboardId);
  // Recompact orders so the remaining items are 1..N-1 contiguous.
  const remaining = await listStoryboards({ beatId });
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

export async function reorderStoryboardsViaGateway({ beatId, orderedIds }) {
  const result = await mongoReorderStoryboards(beatId, orderedIds);
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['order'],
  });
  return result;
}

export async function deleteAllStoryboardsForBeatViaGateway({ beatId }) {
  const removed = await mongoDeleteStoryboardsForBeat(beatId);
  broadcastFieldsUpdated(buildRoomName('storyboards', String(beatId)), {
    changed: ['storyboards'],
    cleared: true,
  });
  return { ok: true, removed_count: removed.length };
}

const STORYBOARD_ROLES = new Set([
  'start_frame',
  'end_frame',
  'character_sheet',
]);

function storyboardRoleField(role) {
  if (role === 'start_frame') return 'start_frame_id';
  if (role === 'end_frame') return 'end_frame_id';
  if (role === 'character_sheet') return 'character_sheet_image_id';
  return null;
}

// Persist the auto-generated description of a storyboard's start frame.
// Used by the storyboard generator after it captions the rendered start
// frame, so the end-frame call can read this string back as a verbal
// anchor for what to preserve. Backend-only; not exposed via the SPA's
// scalar-update path.
export async function setStoryboardStartFrameDescriptionViaGateway({
  storyboardId,
  description,
}) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  await mongoUpdateStoryboard(storyboardId, {
    start_frame_description: String(description || ''),
  });
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: ['start_frame_description'],
    storyboard_id: String(storyboardId),
  });
  return mongoGetStoryboard(storyboardId);
}

export async function setStoryboardImageViaGateway({ storyboardId, role, imageId }) {
  if (!STORYBOARD_ROLES.has(role)) {
    throw new Error(`unknown storyboard role: ${role}`);
  }
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const field = storyboardRoleField(role);
  await mongoUpdateStoryboard(storyboardId, {
    [field]: imageId == null ? null : String(imageId),
  });
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: [field],
    storyboard_id: String(storyboardId),
  });
  return mongoGetStoryboard(storyboardId);
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

export async function updateStoryboardScalarsViaGateway({ storyboardId, patch }) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const filtered = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (STORYBOARD_SCALAR_FIELDS.has(k)) filtered[k] = v;
  }
  if (!Object.keys(filtered).length) {
    throw new Error('updateStoryboardScalars: no recognized fields');
  }
  const result = await mongoUpdateStoryboard(storyboardId, filtered);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: Object.keys(filtered),
    storyboard_id: String(storyboardId),
  });
  return result;
}

export async function addStoryboardReferenceImageViaGateway({ storyboardId, imageId }) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const next = await mongoPushReferenceImage(storyboardId, imageId);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: ['reference_image_ids'],
    storyboard_id: String(storyboardId),
  });
  return next;
}

export async function removeStoryboardReferenceImageViaGateway({ storyboardId, imageId }) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const next = await mongoPullReferenceImage(storyboardId, imageId);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: ['reference_image_ids'],
    storyboard_id: String(storyboardId),
  });
  return next;
}

export async function setStoryboardAudioViaGateway({ storyboardId, audioFileId }) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  await mongoUpdateStoryboard(storyboardId, {
    audio_file_id: audioFileId == null ? null : String(audioFileId),
  });
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: ['audio_file_id'],
    storyboard_id: String(storyboardId),
  });
  return mongoGetStoryboard(storyboardId);
}

// Attach a generated video to a storyboard. Used by the Wan 2.7 image-to-video
// pipeline after it downloads the MP4 into our GridFS attachments bucket.
// Pass videoFileId=null to clear the slot. durationSeconds (when known) is
// the actual MP4 duration the inline player uses for its timeline.
export async function setStoryboardVideoViaGateway({
  storyboardId,
  videoFileId,
  durationSeconds = null,
}) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const patch = {
    video_file_id: videoFileId == null ? null : String(videoFileId),
  };
  if (videoFileId == null) {
    patch.video_duration_seconds = null;
    patch.video_generated_at = null;
  } else {
    if (durationSeconds != null && Number.isFinite(Number(durationSeconds))) {
      patch.video_duration_seconds = Number(durationSeconds);
    }
    patch.video_generated_at = new Date();
  }
  await mongoUpdateStoryboard(storyboardId, patch);
  broadcastFieldsUpdated(buildRoomName('storyboards', sb.beat_id.toString()), {
    changed: Object.keys(patch),
    storyboard_id: String(storyboardId),
  });
  return mongoGetStoryboard(storyboardId);
}

// Copy a dialog item's audio bytes into a fresh GridFS file owned by the
// target storyboard, then point the storyboard's audio_file_id at the new
// file. The dialog and storyboard end up holding independent copies — deleting
// or replacing one does not affect the other.
export async function copyDialogAudioToStoryboardViaGateway({
  storyboardId,
  dialogId,
}) {
  const sb = await mongoGetStoryboard(storyboardId);
  if (!sb) throw new Error(`Storyboard not found: ${storyboardId}`);
  const d = await mongoGetDialog(dialogId);
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

export async function setDialogTextFieldViaGateway({ dialogId, field, text }) {
  if (!DIALOG_TEXT_FIELDS.has(field)) {
    throw new Error(`unknown dialog field: ${field}`);
  }
  const d = await mongoGetDialog(dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  await setEntityFieldMarkdown({
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

// Set a dialog's `character` to a specific existing character's name. The
// name must match (case-insensitive on stripMarkdown) one of the characters
// in the project — the SPA uses this from its autocomplete <CharacterSelect>
// to enforce that dialog speakers are always known characters.
export async function setDialogCharacterViaGateway({ dialogId, characterName }) {
  const d = await mongoGetDialog(dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  const raw = String(characterName ?? '').trim();
  if (!raw) {
    throw new Error('character is required');
  }
  const c = await getCharacter(raw);
  if (!c) {
    throw new Error(`No character named "${raw}". Pick from the project's character list.`);
  }
  const canonical = stripMarkdown(c.name || '').trim() || raw;
  await mongoUpdateDialog(d._id.toString(), { character: canonical });
  broadcastFieldsUpdated(buildRoomName('dialogs', d.beat_id.toString()), {
    changed: ['character'],
    dialog_id: d._id.toString(),
  });
  return mongoGetDialog(d._id.toString());
}

export async function createDialogViaGateway({ beatId, body, character, order, seedFragments }) {
  const d = await mongoCreateDialog({ beatId, body, character, order });
  // Seed body / character y-doc fragments BEFORE broadcasting the ping (see
  // createStoryboardViaGateway for the same reasoning). Without this, the
  // SPA's CollabField for the new dialog mounts against an empty fragment
  // and shows a blank body until the user reloads.
  if (seedFragments) {
    for (const [field, text] of Object.entries(seedFragments)) {
      if (!DIALOG_TEXT_FIELDS.has(field)) continue;
      try {
        await setEntityFieldMarkdown({
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

export async function deleteDialogViaGateway({ dialogId }) {
  const d = await mongoGetDialog(dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  const beatId = d.beat_id.toString();
  await mongoDeleteDialog(dialogId);
  // Recompact orders so the remaining items are 1..N-1 contiguous.
  const remaining = await listDialogs({ beatId });
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

export async function reorderDialogsViaGateway({ beatId, orderedIds }) {
  const result = await mongoReorderDialogs(beatId, orderedIds);
  broadcastFieldsUpdated(buildRoomName('dialogs', String(beatId)), {
    changed: ['order'],
  });
  return result;
}

export async function deleteAllDialogsForBeatViaGateway({ beatId }) {
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
export async function setDialogAudioViaGateway({ dialogId, audioFileId }) {
  const d = await mongoGetDialog(dialogId);
  if (!d) throw new Error(`Dialog not found: ${dialogId}`);
  await mongoUpdateDialog(dialogId, {
    audio_file_id: audioFileId == null ? null : String(audioFileId),
  });
  broadcastFieldsUpdated(buildRoomName('dialogs', d.beat_id.toString()), {
    changed: ['audio_file_id'],
    dialog_id: String(dialogId),
  });
  return mongoGetDialog(dialogId);
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

export async function setLibraryImageMetaViaGateway({ imageId, name, description }) {
  if (name === undefined && description === undefined) return;
  if (name !== undefined) {
    await setEntityFieldMarkdown({
      entityType: 'library',
      entityId: 'library',
      field: libraryFieldName(imageId, 'name'),
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
      entityType: 'library',
      entityId: 'library',
      field: libraryFieldName(imageId, 'description'),
      markdown: description,
    });
  }
  broadcastFieldsUpdated('library', {
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
      entityType: ownerType,
      entityId: idStr,
      field: `image:${String(imageId)}:name`,
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
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

// Character sheets live on c.character_sheet_image_ids[] — outside the
// c.images[] array that the character room descriptor registers as
// fragments. A y-doc fragment write for a sheet image therefore never
// reaches Mongo on the store tick. Sheet names also render via plain
// inputs (not CollabField), so going through the y-doc adds no UX value.
// Write GridFS metadata directly, then broadcast so connected SPAs
// refetch the sheet list.
export async function setCharacterSheetMetaViaGateway({
  character,
  imageId,
  name,
  description,
}) {
  if (name === undefined && description === undefined) return;
  const cidStr = String(character || '');
  if (!cidStr) throw new Error('setCharacterSheetMetaViaGateway: character required');
  await setOwnedImageMeta(String(imageId), {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  });
  broadcastFieldsUpdated(buildRoomName('character', cidStr), {
    changed: ['character_sheet_meta'],
    image_id: String(imageId),
  });
}

function libraryAttachmentFieldName(attachmentId, field) {
  return `library_attachment:${String(attachmentId)}:${field}`;
}

export async function setLibraryAttachmentMetaViaGateway({ attachmentId, name, description }) {
  if (name === undefined && description === undefined) return;
  if (name !== undefined) {
    await setEntityFieldMarkdown({
      entityType: 'library',
      entityId: 'library',
      field: libraryAttachmentFieldName(attachmentId, 'name'),
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
      entityType: 'library',
      entityId: 'library',
      field: libraryAttachmentFieldName(attachmentId, 'description'),
      markdown: description,
    });
  }
  broadcastFieldsUpdated('library', {
    changed: ['library_attachments'],
    attachment_id: String(attachmentId),
  });
}

// Owned-attachment (character / beat) metadata writer. Mirrors
// setOwnedImageMetaViaGateway for attachments. Falls back to direct Mongo via
// setOwnedAttachmentMeta when Hocuspocus isn't running.
export async function setOwnedAttachmentMetaViaGateway({
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
      entityType: ownerType,
      entityId: idStr,
      field: `attachment:${String(attachmentId)}:name`,
      markdown: name,
    });
  }
  if (description !== undefined) {
    await setEntityFieldMarkdown({
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
export async function addLibraryImageViaGateway({ imageMeta }) {
  broadcastFieldsUpdated('library', {
    changed: ['library_images'],
    added_image_id: imageMeta?._id ? String(imageMeta._id) : null,
  });
  return imageMeta;
}

export async function removeLibraryImageViaGateway({ imageId }) {
  await deleteImage(imageId);
  broadcastFieldsUpdated('library', {
    changed: ['library_images'],
    removed_image_id: String(imageId),
  });
}

// Replace one library image with another, copying name/description from the
// source onto the new image and deleting the source. Both ids must currently
// be library images (owner_type === null).
export async function replaceLibraryImageViaGateway({ sourceImageId, newImageId, copyMetadata = true }) {
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
  broadcastFieldsUpdated('library', {
    changed: ['library_images'],
    removed_image_id: String(sourceImageId),
    added_image_id: String(newImageId),
  });
  return { ok: true, new_image_id: String(newImageId) };
}

// ─── Inspection helpers ────────────────────────────────────────────────────

export async function getEntityFieldMarkdown({ entityType, entityId, field }) {
  const { fragmentToMarkdown } = await he();
  const roomName = buildRoomName(entityType, entityId);
  let out;
  await withDirectDocument(roomName, { actor: 'bot' }, (document) => {
    out = fragmentToMarkdown(document, field);
  });
  return out;
}
