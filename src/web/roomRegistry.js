// roomRegistry.js
//
// One Hocuspocus "document" (room) per editable entity. The room name encodes
// the entity type and a stable identifier:
//
//   beat:<beat _id hex>
//   character:<character _id hex>
//   notes
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
  const m = roomName.match(/^([a-z_]+):(.+)$/);
  if (!m) return null;
  const [, type, rest] = m;
  if (type === 'beat' || type === 'character') {
    if (!isOidHex(rest)) return null;
    return { type, id: rest };
  }
  return null;
}

export function buildRoomName(type, id) {
  if (type === 'notes') return 'notes';
  if (!isOidHex(String(id))) throw new Error(`invalid id for room: ${id}`);
  return `${type}:${id}`;
}

export function isManagedRoom(roomName) {
  return parseRoomName(roomName) !== null;
}

// Beat ----------------------------------------------------------------------

const BEAT_FIELDS = ['name', 'desc', 'body'];

async function describeBeatRoom(id) {
  const plot = await getPlot();
  const beat = (plot.beats || []).find((b) => b._id?.toString?.() === id);
  if (!beat) return null;
  return {
    type: 'beat',
    id,
    fields: BEAT_FIELDS,
    seed: BEAT_FIELDS.reduce((acc, f) => {
      acc[f] = beat[f] != null ? String(beat[f]) : '';
      return acc;
    }, {}),
    persistFields: async (snapshot) => {
      const patch = {};
      for (const f of BEAT_FIELDS) {
        if (snapshot[f] !== undefined && snapshot[f] !== beat[f]) patch[f] = snapshot[f];
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
  // template field stored under `fields.<name>`.
  const customFieldNames = template.filter((t) => !t.core).map((t) => t.name);
  const fieldNames = ['name', 'hollywood_actor', ...customFieldNames.map((n) => `fields.${n}`)];

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
    default:
      return null;
  }
}
