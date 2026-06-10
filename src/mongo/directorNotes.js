import { ObjectId } from 'mongodb';
import { getDb } from './client.js';
import { resolveProjectId } from './projects.js';

const col = () => getDb().collection('prompts');
const docId = (projectId) => `${projectId}:director_notes`;

function maybeOid(s) {
  if (s instanceof ObjectId) return s;
  return typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s) ? new ObjectId(s) : null;
}

function toOid(id) {
  const oid = maybeOid(id);
  if (!oid) throw new Error(`invalid id: ${id}`);
  return oid;
}

function backfillNote(n) {
  const next = { ...n };
  if (!Array.isArray(next.images)) next.images = [];
  if (!Array.isArray(next.attachments)) next.attachments = [];
  if (next.main_image_id === undefined) next.main_image_id = null;
  return next;
}

export async function getDirectorNotes(projectId) {
  projectId = await resolveProjectId(projectId);
  const doc = await col().findOne({ _id: docId(projectId) });
  if (!doc) return { _id: docId(projectId), project_id: projectId, notes: [] };
  const notes = (Array.isArray(doc.notes) ? doc.notes : []).map(backfillNote);
  return { ...doc, notes };
}

async function writeNotes(projectId, notes) {
  await col().updateOne(
    { _id: docId(projectId) },
    { $set: { notes, project_id: projectId, updated_at: new Date() } },
    { upsert: true },
  );
  return getDirectorNotes(projectId);
}

// For the y-doc persist write-back in src/web/roomRegistry.js, which
// previously wrote updateOne({_id:'director_notes'}) directly.
export async function writeDirectorNotesArray(projectId, notes) {
  projectId = await resolveProjectId(projectId);
  return writeNotes(projectId, notes);
}

export async function addDirectorNote({ projectId, text, position } = {}) {
  projectId = await resolveProjectId(projectId);
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new Error('text is required');
  const current = await getDirectorNotes(projectId);
  const note = {
    _id: new ObjectId(),
    text: t,
    created_at: new Date(),
    images: [],
    main_image_id: null,
    attachments: [],
  };
  const notes = [...current.notes];
  if (Number.isInteger(position) && position >= 0 && position < notes.length) {
    notes.splice(position, 0, note);
  } else {
    notes.push(note);
  }
  await writeNotes(projectId, notes);
  return note;
}

export async function editDirectorNote({ projectId, noteId, text } = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = maybeOid(noteId);
  if (!oid) throw new Error(`invalid note_id: ${noteId}`);
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new Error('text is required');
  const current = await getDirectorNotes(projectId);
  const idx = current.notes.findIndex((n) => n._id?.equals?.(oid));
  if (idx < 0) throw new Error(`note not found: ${noteId}`);
  const notes = current.notes.map((n, i) => (i === idx ? { ...n, text: t } : n));
  await writeNotes(projectId, notes);
  return notes[idx];
}

export async function removeDirectorNote({ projectId, noteId } = {}) {
  projectId = await resolveProjectId(projectId);
  const oid = maybeOid(noteId);
  if (!oid) throw new Error(`invalid note_id: ${noteId}`);
  const current = await getDirectorNotes(projectId);
  const idx = current.notes.findIndex((n) => n._id?.equals?.(oid));
  if (idx < 0) throw new Error(`note not found: ${noteId}`);
  const notes = current.notes.filter((_, i) => i !== idx);
  await writeNotes(projectId, notes);
}

export async function reorderDirectorNotes({ projectId, noteIds } = {}) {
  projectId = await resolveProjectId(projectId);
  if (!Array.isArray(noteIds)) throw new Error('note_ids must be an array');
  const oids = noteIds.map((id) => {
    const oid = maybeOid(id);
    if (!oid) throw new Error(`invalid note_id: ${id}`);
    return oid;
  });
  const current = await getDirectorNotes(projectId);
  if (oids.length !== current.notes.length) {
    throw new Error(
      `note_ids length ${oids.length} does not match current notes length ${current.notes.length}`,
    );
  }
  const seen = new Set();
  const reordered = [];
  for (const oid of oids) {
    const key = oid.toString();
    if (seen.has(key)) throw new Error(`duplicate note_id: ${key}`);
    seen.add(key);
    const note = current.notes.find((n) => n._id?.equals?.(oid));
    if (!note) throw new Error(`note not found: ${key}`);
    reordered.push(note);
  }
  await writeNotes(projectId, reordered);
  return reordered;
}

function findNoteIndex(notes, noteId) {
  const oid = toOid(noteId);
  const idx = notes.findIndex((n) => n._id?.equals?.(oid));
  if (idx < 0) throw new Error(`note not found: ${noteId}`);
  return idx;
}

export async function pushDirectorNoteImage(projectId, noteId, imageMeta, setAsMain = false) {
  projectId = await resolveProjectId(projectId);
  const current = await getDirectorNotes(projectId);
  const idx = findNoteIndex(current.notes, noteId);
  const note = current.notes[idx];
  const images = [...(note.images || []), imageMeta];
  const promote = !!setAsMain || !note.main_image_id;
  const next = {
    ...note,
    images,
    main_image_id: promote ? imageMeta._id : note.main_image_id || null,
  };
  const notes = current.notes.map((n, i) => (i === idx ? next : n));
  await writeNotes(projectId, notes);
  return { note: next, is_main: promote };
}

export async function pullDirectorNoteImage(projectId, noteId, imageId) {
  projectId = await resolveProjectId(projectId);
  const current = await getDirectorNotes(projectId);
  const idx = findNoteIndex(current.notes, noteId);
  const note = current.notes[idx];
  const oid = toOid(imageId);
  const remaining = (note.images || []).filter((i) => !i._id.equals(oid));
  if (remaining.length === (note.images || []).length) {
    throw new Error(`Image ${imageId} is not attached to this note`);
  }
  const wasMain = note.main_image_id && note.main_image_id.equals(oid);
  const newMain = wasMain ? remaining[0]?._id || null : note.main_image_id || null;
  const next = { ...note, images: remaining, main_image_id: newMain };
  const notes = current.notes.map((n, i) => (i === idx ? next : n));
  await writeNotes(projectId, notes);
  return { note: next, removed: oid };
}

export async function setDirectorNoteMainImage(projectId, noteId, imageId) {
  projectId = await resolveProjectId(projectId);
  const current = await getDirectorNotes(projectId);
  const idx = findNoteIndex(current.notes, noteId);
  const note = current.notes[idx];
  const oid = toOid(imageId);
  if (!(note.images || []).some((i) => i._id.equals(oid))) {
    throw new Error(`Image ${imageId} is not attached to this note`);
  }
  const next = { ...note, main_image_id: oid };
  const notes = current.notes.map((n, i) => (i === idx ? next : n));
  await writeNotes(projectId, notes);
  return next;
}

export async function pushDirectorNoteAttachment(projectId, noteId, attachmentMeta) {
  projectId = await resolveProjectId(projectId);
  const current = await getDirectorNotes(projectId);
  const idx = findNoteIndex(current.notes, noteId);
  const note = current.notes[idx];
  const attachments = [...(note.attachments || []), attachmentMeta];
  const next = { ...note, attachments };
  const notes = current.notes.map((n, i) => (i === idx ? next : n));
  await writeNotes(projectId, notes);
  return next;
}

export async function pullDirectorNoteAttachment(projectId, noteId, attachmentId) {
  projectId = await resolveProjectId(projectId);
  const current = await getDirectorNotes(projectId);
  const idx = findNoteIndex(current.notes, noteId);
  const note = current.notes[idx];
  const oid = toOid(attachmentId);
  const remaining = (note.attachments || []).filter((a) => !a._id.equals(oid));
  if (remaining.length === (note.attachments || []).length) {
    throw new Error(`Attachment ${attachmentId} is not attached to this note`);
  }
  const next = { ...note, attachments: remaining };
  const notes = current.notes.map((n, i) => (i === idx ? next : n));
  await writeNotes(projectId, notes);
  return { note: next, removed: oid };
}

export function getDirectorNote(notes, noteId) {
  const oid = maybeOid(noteId);
  if (!oid) return null;
  return notes.find((n) => n._id?.equals?.(oid)) || null;
}
