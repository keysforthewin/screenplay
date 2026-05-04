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
  getBeat,
} from '../mongo/plots.js';
import {
  getCharacter,
  updateCharacter as mongoUpdateCharacter,
  pushCharacterImage,
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
import { setMainCharacterImage, removeCharacterImage } from '../mongo/files.js';
import { enqueueReindex } from '../rag/queue.js';
import { deleteEntity } from '../rag/indexer.js';

let botDisplayName = 'Screenplay Bot';

export function setBotDisplayName(name) {
  if (typeof name === 'string' && name.trim()) botDisplayName = name.trim();
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
    throw new Error(`gateway fallback: unknown character field "${field}"`);
  }
  if (entityType === 'notes' && field.startsWith('note:') && field.endsWith(':text')) {
    const noteId = field.slice('note:'.length, -':text'.length);
    const doc = await getDirectorNotes();
    const note = (doc.notes || []).find((n) => n._id?.toString?.() === String(noteId));
    if (!note) throw new Error(`Director's note not found: ${noteId}`);
    return String(note.text || '');
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
    return Plots.updateBeat(entityId, { [field]: args.markdown });
  }
  if (entityType === 'character') {
    const { updateCharacter } = await import('../mongo/characters.js');
    if (field === 'name' || field === 'hollywood_actor') {
      return updateCharacter(entityId, { [field]: args.markdown });
    }
    if (field.startsWith('fields.')) {
      return updateCharacter(entityId, { [field]: args.markdown });
    }
  }
  if (entityType === 'notes' && field.startsWith('note:') && field.endsWith(':text')) {
    const noteId = field.slice('note:'.length, -':text'.length);
    const { editDirectorNote } = await import('../mongo/directorNotes.js');
    return editDirectorNote({ noteId, text: args.markdown });
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

// updateBeat may include text fields (name/desc/body) and order; route the text
// fields through the gateway and the order through Mongo.
export async function updateBeatViaGateway(identifier, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(
      `update_beat: \`patch\` must be an object like {body: "..."}, got ${
        Array.isArray(patch) ? 'array' : typeof patch
      }. Wrap your fields in {patch: {body: "..."}} (or name/desc/order/characters).`,
    );
  }
  const recognized = ['name', 'desc', 'body', 'order', 'characters'];
  if (!recognized.some((k) => patch[k] !== undefined)) {
    throw new Error(
      `update_beat: \`patch\` has no recognized fields. Expected one of: ${recognized.join(', ')}. Got keys: [${Object.keys(patch).join(', ')}].`,
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
  // order and characters are non-text → hit Mongo directly via existing helper
  if (patch.order !== undefined || Array.isArray(patch.characters)) {
    const { updateBeat: mongoUpdateBeat } = await import('../mongo/plots.js');
    const onlyDiscrete = {};
    if (patch.order !== undefined) onlyDiscrete.order = patch.order;
    if (Array.isArray(patch.characters)) onlyDiscrete.characters = patch.characters;
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
      k === 'plays_self' ||
      k === 'hollywood_actor' ||
      k === 'own_voice' ||
      k === 'unset',
  );
  if (!recognized) {
    throw new Error(
      `update_character: \`patch\` has no recognized fields. Expected name, fields, fields.<key>, plays_self, hollywood_actor, own_voice, or unset. Got keys: [${Object.keys(patch).join(', ')}].`,
    );
  }
  const c = await getCharacter(identifier);
  if (!c) throw new Error(`Character not found: ${identifier}`);
  const cid = c._id.toString();
  // Split text fields (name, hollywood_actor, fields.*) from discrete fields
  // (plays_self, own_voice) and `unset`.
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
