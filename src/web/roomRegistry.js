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
} from '../mongo/storyboards.js';
import {
  listDialogs,
  updateDialog,
} from '../mongo/dialogs.js';
import {
  listLibraryImages,
  setLibraryImageMeta,
} from '../mongo/images.js';
import { getDb } from '../mongo/client.js';
import { getCharacterTemplate } from '../mongo/prompts.js';
import { stripMarkdown } from '../util/markdown.js';
import { SPECIFICS_FIELD_NAMES } from '../util/specifics.js';
import { BEAT_SPECIFICS_FIELD_NAMES } from '../util/beatSpecifics.js';
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

// Beat ----------------------------------------------------------------------

const BEAT_TOP_FIELDS = ['name', 'desc', 'body'];

async function describeBeatRoom(id) {
  const plot = await getPlot();
  const beat = (plot.beats || []).find((b) => b._id?.toString?.() === id);
  if (!beat) return null;
  const fieldNames = [
    ...BEAT_TOP_FIELDS,
    ...BEAT_SPECIFICS_FIELD_NAMES.map((n) => `specifics.${n}`),
  ];

  function readMongoValue(fieldName) {
    if (BEAT_TOP_FIELDS.includes(fieldName)) {
      return beat[fieldName] != null ? String(beat[fieldName]) : '';
    }
    if (fieldName.startsWith('specifics.')) {
      const key = fieldName.slice('specifics.'.length);
      const v = beat.specifics?.[key];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    return '';
  }

  return {
    type: 'beat',
    id,
    fields: fieldNames,
    seed: fieldNames.reduce((acc, f) => {
      acc[f] = readMongoValue(f);
      return acc;
    }, {}),
    persistFields: async (snapshot) => {
      const patch = {};
      for (const f of fieldNames) {
        if (snapshot[f] === undefined) continue;
        if (snapshot[f] === readMongoValue(f)) continue;
        if (BEAT_TOP_FIELDS.includes(f)) {
          patch[f] = snapshot[f];
        } else if (f.startsWith('specifics.')) {
          patch[f] = snapshot[f];
        }
      }
      if (!Object.keys(patch).length) return { changed: false };
      await updateBeat(id, patch);
      enqueueReindex('beat', id);
      return { changed: true, fields: Object.keys(patch) };
    },
  };
}

// Character -----------------------------------------------------------------

async function describeCharacterRoom(id) {
  const c = await getCharacter(id);
  if (!c) return null;
  const template = (await getCharacterTemplate())?.fields || [];
  // Editable text fields: name + hollywood_actor (top-level) + every non-core
  // template field stored under `fields.<name>` + every specifics field stored
  // under `specifics.<name>`.
  const customFieldNames = template.filter((t) => !t.core).map((t) => t.name);
  const fieldNames = [
    'name',
    'hollywood_actor',
    ...customFieldNames.map((n) => `fields.${n}`),
    ...SPECIFICS_FIELD_NAMES.map((n) => `specifics.${n}`),
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
    if (fieldName.startsWith('specifics.')) {
      const key = fieldName.slice('specifics.'.length);
      const v = c.specifics?.[key];
      if (v == null) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    return '';
  }

  return {
    type: 'character',
    id,
    fields: fieldNames,
    seed: fieldNames.reduce((acc, f) => {
      acc[f] = readMongoValue(f);
      return acc;
    }, {}),
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
        } else if (f.startsWith('specifics.')) {
          patch[f] = snapshot[f];
        }
      }
      if (!Object.keys(patch).length) return { changed: false };
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
      return { changed: true, fields: Object.keys(patch) };
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
// One y-doc per beat (room: "storyboards:<beatId>"). Each storyboard's
// `text_prompt` is a fragment named "item:<storyboard _id>:text_prompt". When
// storyboards are added/removed the room composition changes; the seed reflects
// whatever exists in Mongo at the time the room is loaded.

function storyboardFieldName(storyboardId) {
  return `item:${storyboardId}:text_prompt`;
}

async function describeStoryboardsRoom(beatId) {
  const sbs = await listStoryboards({ beatId });
  const fields = sbs.map((s) => storyboardFieldName(s._id.toString()));
  const seed = {};
  const sbById = new Map();
  for (const s of sbs) {
    seed[storyboardFieldName(s._id.toString())] = s.text_prompt || '';
    sbById.set(s._id.toString(), s);
  }
  return {
    type: 'storyboards',
    id: beatId,
    fields,
    seed,
    persistFields: async (snapshot) => {
      const changedFields = [];
      for (const [field, value] of Object.entries(snapshot)) {
        const m = field.match(/^item:([a-f0-9]{24}):text_prompt$/);
        if (!m) continue;
        const sbId = m[1];
        const current = sbById.get(sbId);
        if (!current) continue;
        if (value === current.text_prompt) continue;
        try {
          await updateStoryboard(sbId, { text_prompt: value });
          changedFields.push(field);
        } catch (e) {
          logger.warn(`storyboards persist failed sb=${sbId}: ${e.message}`);
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

async function describeLibraryRoom() {
  const files = await listLibraryImages();
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

  return {
    type: 'library',
    id: 'library',
    fields,
    seed,
    persistFields: async (snapshot) => {
      // Group by image id so each persist is a single Mongo update per file.
      const perImage = new Map();
      for (const [field, value] of Object.entries(snapshot)) {
        const m = field.match(LIBRARY_FIELD_RE);
        if (!m) continue;
        const id = m[1];
        const which = m[2];
        const current = fileById.get(id);
        if (!current) continue;
        if (value === (current.metadata?.[which] || '')) continue;
        if (!perImage.has(id)) perImage.set(id, {});
        perImage.get(id)[which] = value;
      }
      if (!perImage.size) return { changed: false };
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
