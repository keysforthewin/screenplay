// roomRegistry.js
//
// One Hocuspocus "document" (room) per editable entity. The room name encodes
// the entity type and a stable identifier:
//
//   beat:<beat _id hex>
//   character:<character _id hex>
//   notes
//   storyboards:<beat _id hex>   — one room per beat, multiple item fragments
//
// Each entity exposes a list of *text fields* (each becomes a Yjs XmlFragment
// inside the y-doc) plus knowledge of how to read/write each field to Mongo.
//
// This module is the single source of truth for the mapping. The Hocuspocus
// persistence hooks call resolveRoom() and use the returned descriptor to:
//
//   - seed fragments from Mongo when a y-doc is loaded for the first time
//   - render fragments to markdown and persist to Mongo on store ticks

import { ObjectId } from 'mongodb';
import { getPlot, updateBeat } from '../mongo/plots.js';
import { getCharacter, updateCharacter } from '../mongo/characters.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import {
  listStoryboards,
  updateStoryboard,
  setFramePrompt,
} from '../mongo/storyboards.js';
import {
  listDialogs,
  updateDialog,
} from '../mongo/dialogs.js';
import {
  listLibraryImages,
  setLibraryImageMeta,
  setOwnedImageMeta,
  findImageFile,
} from '../mongo/images.js';
import {
  listLibraryAttachments,
  setLibraryAttachmentMeta,
  setOwnedAttachmentMeta,
  findAttachmentFile,
} from '../mongo/attachments.js';
import { getDb } from '../mongo/client.js';
import { getCharacterTemplate } from '../mongo/prompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { logger } from '../log.js';
import { enqueueReindex } from '../rag/queue.js';
// Side-effect import: registers the reindex runner with the queue.
import '../rag/indexer.js';

const HEX24 = /^[a-f0-9]{24}$/i;

function isOidHex(s) {
  return typeof s === 'string' && HEX24.test(s);
}

export function parseRoomName(roomName) {
  if (typeof roomName !== 'string') return null;
  if (roomName === 'notes') return { type: 'notes' };
  if (roomName === 'library') return { type: 'library' };
  const m = roomName.match(/^([a-z_]+):(.+)$/);
  if (!m) return null;
  const [, type, rest] = m;
  if (
    type === 'beat' ||
    type === 'character' ||
    type === 'storyboards' ||
    type === 'dialogs'
  ) {
    if (!isOidHex(rest)) return null;
    return { type, id: rest };
  }
  return null;
}

export function buildRoomName(type, id) {
  if (type === 'notes') return 'notes';
  if (type === 'library') return 'library';
  if (!isOidHex(String(id))) throw new Error(`invalid id for room: ${id}`);
  return `${type}:${id}`;
}

export function isManagedRoom(roomName) {
  return parseRoomName(roomName) !== null;
}

// Per-image text fragments shared between beat and character rooms.
//
//   image:<imageId>:name
//   image:<imageId>:description
//
// Both back GridFS file metadata (images.files.metadata.{name,description}).
// `name_lower` is recomputed from stripMarkdown(name) on every persist via
// setOwnedImageMeta. The `image:` prefix collides with no other field key
// pattern in beat/character rooms.

const OWNED_IMAGE_FIELDS = ['name', 'description'];
const OWNED_IMAGE_FIELD_RE = /^image:([a-f0-9]{24}):(name|description)$/;

function ownedImageFieldName(imageId, field) {
  return `image:${imageId}:${field}`;
}

async function describeOwnedImageFragments(images) {
  const ids = (images || []).map((img) => img._id?.toString?.()).filter(Boolean);
  if (!ids.length) return { fields: [], seed: {} };
  const files = await Promise.all(ids.map((id) => findImageFile(id).catch(() => null)));
  const fields = [];
  const seed = {};
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const file = files[i];
    for (const which of OWNED_IMAGE_FIELDS) {
      const name = ownedImageFieldName(id, which);
      fields.push(name);
      seed[name] = String(file?.metadata?.[which] || '');
    }
  }
  return { fields, seed };
}

async function persistOwnedImageFragments(snapshot, seed) {
  const perImage = new Map();
  const matched = [];
  for (const [field, value] of Object.entries(snapshot || {})) {
    const m = field.match(OWNED_IMAGE_FIELD_RE);
    if (!m) continue;
    matched.push(field);
    if (value === undefined) continue;
    if (value === (seed[field] || '')) continue;
    const id = m[1];
    const which = m[2];
    if (!perImage.has(id)) perImage.set(id, {});
    perImage.get(id)[which] = value;
  }
  const changedFields = [];
  for (const [id, patch] of perImage.entries()) {
    try {
      await setOwnedImageMeta(id, patch);
      for (const k of Object.keys(patch)) changedFields.push(ownedImageFieldName(id, k));
    } catch (e) {
      logger.warn(`owned image persist failed image=${id}: ${e.message}`);
    }
  }
  return { matchedFields: matched, changedFields };
}

// Per-attachment text fragments shared between beat and character rooms,
// mirroring the OWNED_IMAGE_* helpers above.
//
//   attachment:<attachmentId>:name
//   attachment:<attachmentId>:description
//
// Both back GridFS file metadata (attachments.files.metadata.{name,description}).
// The legacy embedded `caption` field on the entity's attachments[] array is
// not authoritative — name/description in GridFS metadata are.

const OWNED_ATTACH_FIELDS = ['name', 'description'];
const OWNED_ATTACH_FIELD_RE = /^attachment:([a-f0-9]{24}):(name|description)$/;

function ownedAttachmentFieldName(attachmentId, field) {
  return `attachment:${attachmentId}:${field}`;
}

async function describeOwnedAttachmentFragments(attachments) {
  const ids = (attachments || []).map((a) => a._id?.toString?.()).filter(Boolean);
  if (!ids.length) return { fields: [], seed: {} };
  const files = await Promise.all(ids.map((id) => findAttachmentFile(id).catch(() => null)));
  const fields = [];
  const seed = {};
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const file = files[i];
    for (const which of OWNED_ATTACH_FIELDS) {
      const name = ownedAttachmentFieldName(id, which);
      fields.push(name);
      seed[name] = String(file?.metadata?.[which] || '');
    }
  }
  return { fields, seed };
}

async function persistOwnedAttachmentFragments(snapshot, seed) {
  const perAttachment = new Map();
  const matched = [];
  for (const [field, value] of Object.entries(snapshot || {})) {
    const m = field.match(OWNED_ATTACH_FIELD_RE);
    if (!m) continue;
    matched.push(field);
    if (value === undefined) continue;
    if (value === (seed[field] || '')) continue;
    const id = m[1];
    const which = m[2];
    if (!perAttachment.has(id)) perAttachment.set(id, {});
    perAttachment.get(id)[which] = value;
  }
  const changedFields = [];
  for (const [id, patch] of perAttachment.entries()) {
    try {
      await setOwnedAttachmentMeta(id, patch);
      for (const k of Object.keys(patch)) changedFields.push(ownedAttachmentFieldName(id, k));
    } catch (e) {
      logger.warn(`owned attachment persist failed attachment=${id}: ${e.message}`);
    }
  }
  return { matchedFields: matched, changedFields };
}

// Beat ----------------------------------------------------------------------

const BEAT_TOP_FIELDS = ['name', 'desc', 'body'];

async function describeBeatRoom(id) {
  const plot = await getPlot();
  const beat = (plot.beats || []).find((b) => b._id?.toString?.() === id);
  if (!beat) return null;
  const fieldNames = [...BEAT_TOP_FIELDS];

  function readMongoValue(fieldName) {
    if (BEAT_TOP_FIELDS.includes(fieldName)) {
      return beat[fieldName] != null ? String(beat[fieldName]) : '';
    }
    return '';
  }

  const imageFragments = await describeOwnedImageFragments(beat.images);
  const attachmentFragments = await describeOwnedAttachmentFragments(beat.attachments);
  const allFields = [...fieldNames, ...imageFragments.fields, ...attachmentFragments.fields];
  const seed = fieldNames.reduce((acc, f) => {
    acc[f] = readMongoValue(f);
    return acc;
  }, {});
  Object.assign(seed, imageFragments.seed, attachmentFragments.seed);

  return {
    type: 'beat',
    id,
    fields: allFields,
    seed,
    persistFields: async (snapshot) => {
      const patch = {};
      for (const f of fieldNames) {
        if (snapshot[f] === undefined) continue;
        if (snapshot[f] === readMongoValue(f)) continue;
        if (BEAT_TOP_FIELDS.includes(f)) {
          patch[f] = snapshot[f];
        }
      }
      const imgPersist = await persistOwnedImageFragments(snapshot, imageFragments.seed);
      const attachPersist = await persistOwnedAttachmentFragments(
        snapshot,
        attachmentFragments.seed,
      );
      const entityChangedKeys = Object.keys(patch);
      if (entityChangedKeys.length) {
        await updateBeat(id, patch);
        enqueueReindex('beat', id);
      }
      const allChanged = [
        ...entityChangedKeys,
        ...imgPersist.changedFields,
        ...attachPersist.changedFields,
      ];
      if (!allChanged.length) return { changed: false };
      return { changed: true, fields: allChanged };
    },
  };
}

// Character -----------------------------------------------------------------

async function describeCharacterRoom(id) {
  const c = await getCharacter(id);
  if (!c) return null;
  const template = (await getCharacterTemplate())?.fields || [];
  // Editable text fields: name + hollywood_actor (top-level) + every non-core
  // template field stored under `fields.<name>`.
  const customFieldNames = template.filter((t) => !t.core).map((t) => t.name);
  const fieldNames = [
    'name',
    'hollywood_actor',
    ...customFieldNames.map((n) => `fields.${n}`),
  ];

  function readMongoValue(fieldName) {
    if (fieldName === 'name') return c.name || '';
    if (fieldName === 'hollywood_actor') return c.hollywood_actor || '';
    if (fieldName.startsWith('fields.')) {
      const key = fieldName.slice('fields.'.length);
      const v = c.fields?.[key];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    return '';
  }

  const imageFragments = await describeOwnedImageFragments(c.images);
  const attachmentFragments = await describeOwnedAttachmentFragments(c.attachments);
  const allFields = [...fieldNames, ...imageFragments.fields, ...attachmentFragments.fields];
  const seed = fieldNames.reduce((acc, f) => {
    acc[f] = readMongoValue(f);
    return acc;
  }, {});
  Object.assign(seed, imageFragments.seed, attachmentFragments.seed);

  return {
    type: 'character',
    id,
    fields: allFields,
    seed,
    persistFields: async (snapshot) => {
      const patch = {};
      for (const f of fieldNames) {
        if (snapshot[f] === undefined) continue;
        if (snapshot[f] === readMongoValue(f)) continue;
        if (f === 'name') {
          patch.name = snapshot[f];
        } else if (f === 'hollywood_actor') {
          patch.hollywood_actor = snapshot[f];
        } else if (f.startsWith('fields.')) {
          patch[f] = snapshot[f];
        }
      }
      const imgPersist = await persistOwnedImageFragments(snapshot, imageFragments.seed);
      const attachPersist = await persistOwnedAttachmentFragments(
        snapshot,
        attachmentFragments.seed,
      );
      const entityChangedKeys = Object.keys(patch);
      if (entityChangedKeys.length) {
        // Recompute name_lower from stripped markdown to keep lookups working.
        if (patch.name !== undefined) {
          const stripped = stripMarkdown(patch.name);
          await getDb().collection('characters').updateOne(
            { _id: c._id },
            { $set: { name_lower: stripped.toLowerCase() } },
          );
        }
        await updateCharacter(id, patch);
        enqueueReindex('character', id);
      }
      const allChanged = [
        ...entityChangedKeys,
        ...imgPersist.changedFields,
        ...attachPersist.changedFields,
      ];
      if (!allChanged.length) return { changed: false };
      return { changed: true, fields: allChanged };
    },
  };
}

// Director's notes ----------------------------------------------------------
//
// One y-doc for all director notes (room: "notes"). Each note's `text` is a
// fragment named "note:<note _id>:text".

function noteFieldName(noteId) {
  return `note:${noteId}:text`;
}

async function describeNotesRoom() {
  const doc = await getDirectorNotes();
  const notes = doc.notes || [];
  const fields = notes.map((n) => noteFieldName(n._id.toString()));
  const seed = {};
  for (const n of notes) seed[noteFieldName(n._id.toString())] = n.text || '';

  return {
    type: 'notes',
    id: 'notes',
    fields,
    seed,
    persistFields: async (snapshot) => {
      const col = getDb().collection('prompts');
      const updates = {};
      let changed = false;
      const fresh = await getDirectorNotes();
      const nextNotes = (fresh.notes || []).map((n) => {
        const field = noteFieldName(n._id.toString());
        const newText = snapshot[field];
        if (newText !== undefined && newText !== n.text) {
          changed = true;
          return { ...n, text: newText };
        }
        return n;
      });
      if (!changed) return { changed: false };
      await col.updateOne(
        { _id: 'director_notes' },
        { $set: { notes: nextNotes, updated_at: new Date() } },
      );
      logger.info(`mongo: director_notes batch update fields=${Object.keys(snapshot).length}`);
      for (const fieldName of Object.keys(snapshot)) {
        const m = fieldName.match(/^note:([a-f0-9]{24}):text$/);
        if (m) enqueueReindex('director_note', m[1]);
      }
      return { changed: true, fields: Object.keys(snapshot) };
    },
  };
}

// Storyboards ---------------------------------------------------------------
//
// One y-doc per beat (room: "storyboards:<beatId>"). Each storyboard exposes
// scalar text fragments — "item:<storyboard _id>:text_prompt" and ":summary" —
// plus one fragment per frame in its pool:
// "item:<storyboard _id>:frame:<frameId>:prompt". When storyboards or frames are
// added/removed the room composition changes; the seed reflects whatever exists
// in Mongo at the time the room is loaded.

const STORYBOARD_FIELD_NAMES = ['text_prompt', 'summary'];

function storyboardFieldName(storyboardId, field) {
  return `item:${storyboardId}:${field}`;
}

function frameFragmentName(storyboardId, frameId) {
  return `item:${storyboardId}:frame:${frameId}:prompt`;
}

async function describeStoryboardsRoom(beatId) {
  const sbs = await listStoryboards({ beatId });
  const fields = [];
  const seed = {};
  const sbById = new Map();
  for (const s of sbs) {
    const id = s._id.toString();
    sbById.set(id, s);
    for (const f of STORYBOARD_FIELD_NAMES) {
      const name = storyboardFieldName(id, f);
      fields.push(name);
      seed[name] = s[f] || '';
    }
    for (const frame of s.frames || []) {
      const name = frameFragmentName(id, frame._id.toString());
      fields.push(name);
      seed[name] = frame.prompt || '';
    }
  }
  return {
    type: 'storyboards',
    id: beatId,
    fields,
    seed,
    persistFields: async (snapshot) => {
      const changedFields = [];
      for (const [field, value] of Object.entries(snapshot)) {
        // Per-frame prompt fragment.
        const fm = field.match(/^item:([a-f0-9]{24}):frame:([a-f0-9]{24}):prompt$/);
        if (fm) {
          const [, sbId, frameId] = fm;
          const current = sbById.get(sbId);
          const frame = current?.frames?.find((x) => x._id.toString() === frameId);
          if (!frame) continue;
          if (value === (frame.prompt || '')) continue;
          try {
            await setFramePrompt(sbId, frameId, value);
            changedFields.push(field);
          } catch (e) {
            logger.warn(
              `storyboards persist failed sb=${sbId} frame=${frameId}: ${e.message}`,
            );
          }
          continue;
        }
        // Scalar text fragments.
        const m = field.match(/^item:([a-f0-9]{24}):(text_prompt|summary)$/);
        if (!m) continue;
        const sbId = m[1];
        const fieldName = m[2];
        const current = sbById.get(sbId);
        if (!current) continue;
        if (value === (current[fieldName] || '')) continue;
        try {
          await updateStoryboard(sbId, { [fieldName]: value });
          changedFields.push(field);
        } catch (e) {
          logger.warn(`storyboards persist failed sb=${sbId} field=${fieldName}: ${e.message}`);
        }
      }
      return changedFields.length
        ? { changed: true, fields: changedFields }
        : { changed: false };
    },
  };
}

// Dialogs -------------------------------------------------------------------
//
// One y-doc per beat (room: "dialogs:<beatId>"). Each dialog item exposes two
// fragments: "item:<dialog _id>:body" and "item:<dialog _id>:character". When
// dialogs are added/removed the room composition changes; the seed reflects
// whatever exists in Mongo at the time the room is loaded.

const DIALOG_FIELD_NAMES = ['body', 'character'];

function dialogFieldName(dialogId, field) {
  return `item:${dialogId}:${field}`;
}

async function describeDialogsRoom(beatId) {
  const dialogs = await listDialogs({ beatId });
  const fields = [];
  const seed = {};
  const dialogById = new Map();
  for (const d of dialogs) {
    const id = d._id.toString();
    dialogById.set(id, d);
    for (const f of DIALOG_FIELD_NAMES) {
      const fieldName = dialogFieldName(id, f);
      fields.push(fieldName);
      seed[fieldName] = d[f] || '';
    }
  }
  return {
    type: 'dialogs',
    id: beatId,
    fields,
    seed,
    persistFields: async (snapshot) => {
      const changedFields = [];
      for (const [field, value] of Object.entries(snapshot)) {
        const m = field.match(/^item:([a-f0-9]{24}):(body|character)$/);
        if (!m) continue;
        const dId = m[1];
        const fieldName = m[2];
        const current = dialogById.get(dId);
        if (!current) continue;
        if (value === (current[fieldName] || '')) continue;
        try {
          await updateDialog(dId, { [fieldName]: value });
          changedFields.push(field);
        } catch (e) {
          logger.warn(`dialogs persist failed dialog=${dId} field=${fieldName}: ${e.message}`);
        }
      }
      return changedFields.length
        ? { changed: true, fields: changedFields }
        : { changed: false };
    },
  };
}

// Library -------------------------------------------------------------------
//
// One y-doc shared by the entire library (room: "library"). Each library
// image exposes two text fragments:
//   library:<imageId>:name
//   library:<imageId>:description
// Both back GridFS file metadata (images.files.metadata.{name,description});
// `name_lower` is recomputed from stripMarkdown(name) on every persist so
// case-insensitive search keeps working.

const LIBRARY_FIELDS = ['name', 'description'];

function libraryFieldName(imageId, field) {
  return `library:${imageId}:${field}`;
}

const LIBRARY_FIELD_RE = /^library:([a-f0-9]{24}):(name|description)$/;

const LIBRARY_ATTACH_FIELDS = ['name', 'description'];

function libraryAttachmentFieldName(attachmentId, field) {
  return `library_attachment:${attachmentId}:${field}`;
}

const LIBRARY_ATTACH_FIELD_RE = /^library_attachment:([a-f0-9]{24}):(name|description)$/;

async function describeLibraryRoom() {
  const [files, attachmentFiles] = await Promise.all([
    listLibraryImages(),
    listLibraryAttachments(),
  ]);
  const fields = [];
  const seed = {};
  const fileById = new Map();
  for (const f of files) {
    const id = f._id.toString();
    fileById.set(id, f);
    for (const fname of LIBRARY_FIELDS) {
      const fieldName = libraryFieldName(id, fname);
      fields.push(fieldName);
      seed[fieldName] = String(f.metadata?.[fname] || '');
    }
  }
  const attachmentById = new Map();
  for (const f of attachmentFiles) {
    const id = f._id.toString();
    attachmentById.set(id, f);
    for (const fname of LIBRARY_ATTACH_FIELDS) {
      const fieldName = libraryAttachmentFieldName(id, fname);
      fields.push(fieldName);
      seed[fieldName] = String(f.metadata?.[fname] || '');
    }
  }

  return {
    type: 'library',
    id: 'library',
    fields,
    seed,
    persistFields: async (snapshot) => {
      // Group by image / attachment id so each persist is a single Mongo
      // update per file.
      const perImage = new Map();
      const perAttachment = new Map();
      for (const [field, value] of Object.entries(snapshot)) {
        const im = field.match(LIBRARY_FIELD_RE);
        if (im) {
          const id = im[1];
          const which = im[2];
          const current = fileById.get(id);
          if (!current) continue;
          if (value === (current.metadata?.[which] || '')) continue;
          if (!perImage.has(id)) perImage.set(id, {});
          perImage.get(id)[which] = value;
          continue;
        }
        const am = field.match(LIBRARY_ATTACH_FIELD_RE);
        if (am) {
          const id = am[1];
          const which = am[2];
          const current = attachmentById.get(id);
          if (!current) continue;
          if (value === (current.metadata?.[which] || '')) continue;
          if (!perAttachment.has(id)) perAttachment.set(id, {});
          perAttachment.get(id)[which] = value;
        }
      }
      if (!perImage.size && !perAttachment.size) return { changed: false };
      const changedFields = [];
      for (const [id, patch] of perImage.entries()) {
        try {
          await setLibraryImageMeta(id, patch);
          for (const k of Object.keys(patch)) {
            changedFields.push(libraryFieldName(id, k));
          }
        } catch (e) {
          logger.warn(`library persist failed image=${id}: ${e.message}`);
        }
      }
      for (const [id, patch] of perAttachment.entries()) {
        try {
          await setLibraryAttachmentMeta(id, patch);
          for (const k of Object.keys(patch)) {
            changedFields.push(libraryAttachmentFieldName(id, k));
          }
        } catch (e) {
          logger.warn(`library persist failed attachment=${id}: ${e.message}`);
        }
      }
      return changedFields.length
        ? { changed: true, fields: changedFields }
        : { changed: false };
    },
  };
}

// Resolver ------------------------------------------------------------------

export async function resolveRoom(roomName) {
  const parsed = parseRoomName(roomName);
  if (!parsed) return null;
  switch (parsed.type) {
    case 'beat':
      return describeBeatRoom(parsed.id);
    case 'character':
      return describeCharacterRoom(parsed.id);
    case 'notes':
      return describeNotesRoom();
    case 'library':
      return describeLibraryRoom();
    case 'storyboards':
      return describeStoryboardsRoom(parsed.id);
    case 'dialogs':
      return describeDialogsRoom(parsed.id);
    default:
      return null;
  }
}
