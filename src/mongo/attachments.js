import { GridFSBucket } from 'mongodb';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from './client.js';
import { getCharacter } from './characters.js';
import { pushBeatAttachment, getBeat } from './plots.js';
import { pushDirectorNoteAttachment, getDirectorNotes } from './directorNotes.js';
import {
  fetchAttachmentFromUrl,
  deriveAttachmentFilename,
  toObjectId,
} from './attachmentBytes.js';

const BUCKET_NAME = 'attachments';

let bucket;
function getBucket() {
  if (!bucket) bucket = new GridFSBucket(getDb(), { bucketName: BUCKET_NAME });
  return bucket;
}

function filesCol() {
  return getDb().collection(`${BUCKET_NAME}.files`);
}

function uploadBuffer({ buffer, filename, contentType, metadata }) {
  return new Promise((resolve, reject) => {
    const stream = getBucket().openUploadStream(filename, { contentType, metadata });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(buffer);
  });
}

export async function uploadAttachmentBuffer({
  buffer,
  filename,
  contentType,
  ownerType = null,
  ownerId = null,
}) {
  const ct = contentType || 'application/octet-stream';
  const finalFilename = filename?.trim() || `attachment-${Date.now()}.bin`;
  const metadata = {
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'upload',
    content_type: ct,
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType: ct, metadata });
  return {
    _id: id,
    filename: finalFilename,
    content_type: ct,
    size: buffer.length,
    metadata,
    uploaded_at: new Date(),
  };
}

export async function uploadAttachmentFromUrl({
  sourceUrl,
  filename,
  contentType: hintedContentType,
  ownerType = null,
  ownerId = null,
}) {
  const { buffer, contentType, size } = await fetchAttachmentFromUrl(
    sourceUrl,
    hintedContentType,
  );
  const finalFilename = filename?.trim() || deriveAttachmentFilename(sourceUrl, contentType);
  const metadata = {
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'upload',
    content_type: contentType,
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType, metadata });
  return {
    _id: id,
    filename: finalFilename,
    content_type: contentType,
    size,
    metadata,
    uploaded_at: new Date(),
  };
}

export async function findAttachmentFile(attachmentId) {
  return filesCol().findOne({ _id: toObjectId(attachmentId) });
}

export async function listLibraryAttachments() {
  return filesCol()
    .find({ 'metadata.owner_type': null })
    .sort({ uploadDate: -1 })
    .toArray();
}

export async function listAttachmentsForCharacter(characterId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'character', 'metadata.owner_id': toObjectId(characterId) })
    .sort({ uploadDate: 1 })
    .toArray();
}

export async function listAttachmentsForBeat(beatId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'beat', 'metadata.owner_id': toObjectId(beatId) })
    .sort({ uploadDate: 1 })
    .toArray();
}

export async function listAttachmentsForDirectorNote(noteId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'director_note', 'metadata.owner_id': toObjectId(noteId) })
    .sort({ uploadDate: 1 })
    .toArray();
}

export async function setAttachmentOwner(attachmentId, { ownerType, ownerId }) {
  const oid = toObjectId(attachmentId);
  await filesCol().updateOne(
    { _id: oid },
    {
      $set: {
        'metadata.owner_type': ownerType,
        'metadata.owner_id': ownerId ? toObjectId(ownerId) : null,
      },
    },
  );
}

export async function deleteAttachment(attachmentId) {
  const oid = toObjectId(attachmentId);
  try {
    await getBucket().delete(oid);
  } catch (e) {
    if (e?.code !== 'ENOENT' && !/FileNotFound/i.test(e?.message || '')) throw e;
  }
}

export async function deleteAttachments(attachmentIds) {
  for (const id of attachmentIds || []) {
    if (id) await deleteAttachment(id);
  }
}

export function openAttachmentDownloadStream(attachmentId) {
  return getBucket().openDownloadStream(toObjectId(attachmentId));
}

export async function readAttachmentBuffer(attachmentId) {
  const file = await findAttachmentFile(attachmentId);
  if (!file) return null;
  const chunks = [];
  await new Promise((resolve, reject) => {
    const dl = getBucket().openDownloadStream(file._id);
    dl.on('data', (c) => chunks.push(c));
    dl.on('error', reject);
    dl.on('end', resolve);
  });
  return { buffer: Buffer.concat(chunks), file };
}

export async function streamAttachmentToTmp(attachmentId) {
  const file = await findAttachmentFile(attachmentId);
  if (!file) throw new Error(`Attachment not found: ${attachmentId}`);
  const dir = path.join(os.tmpdir(), 'screenplay-attachments');
  await fsp.mkdir(dir, { recursive: true });
  const safeName = (file.filename || 'attachment.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  const filepath = path.join(dir, `${file._id.toString()}-${safeName}`);
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filepath);
    const dl = getBucket().openDownloadStream(file._id);
    dl.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', resolve);
    dl.pipe(writer);
  });
  return { path: filepath, file };
}

export function attachmentFileToMeta(file) {
  return {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType || file.metadata?.content_type || 'application/octet-stream',
    size: file.length,
    source: file.metadata?.source || 'upload',
    uploaded_at: file.uploadDate,
  };
}

async function pushCharacterAttachment(characterId, attachmentMeta) {
  await getDb()
    .collection('characters')
    .updateOne(
      { _id: characterId },
      { $push: { attachments: attachmentMeta }, $set: { updated_at: new Date() } },
    );
}

export async function attachToCharacter({ character, sourceUrl, filename, caption }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const file = await uploadAttachmentFromUrl({
    sourceUrl,
    filename,
    ownerType: 'character',
    ownerId: c._id,
  });
  const meta = {
    _id: file._id,
    filename: file.filename,
    content_type: file.content_type,
    size: file.size,
    caption: caption?.trim() || null,
    uploaded_at: file.uploaded_at,
  };
  await pushCharacterAttachment(c._id, meta);
  return { character: c.name, ...meta };
}

function ownerConflictError(file, attachmentId, targetOwnerType, targetOwnerSameAs) {
  const t = file.metadata?.owner_type;
  if (!t) return null;
  if (t === targetOwnerType && file.metadata?.owner_id && targetOwnerSameAs(file.metadata.owner_id)) {
    return 'already_attached';
  }
  return new Error(
    `Attachment ${attachmentId} is currently attached to a ${t}. Detach it first.`,
  );
}

function buildAttachmentMeta(file, caption) {
  return {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType || file.metadata?.content_type || 'application/octet-stream',
    size: file.length,
    caption: caption?.trim() || null,
    uploaded_at: file.uploadDate,
  };
}

export async function attachExistingAttachmentToCharacter({ character, attachmentId, caption }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const file = await findAttachmentFile(attachmentId);
  if (!file) throw new Error(`Attachment not found: ${attachmentId}`);

  const conflict = ownerConflictError(file, attachmentId, 'character', (id) => id.equals(c._id));
  if (conflict === 'already_attached') {
    return {
      already_attached: true,
      character: c.name,
      _id: file._id,
      filename: file.filename,
    };
  }
  if (conflict instanceof Error) throw conflict;

  await setAttachmentOwner(attachmentId, { ownerType: 'character', ownerId: c._id });
  const meta = buildAttachmentMeta(file, caption);
  await pushCharacterAttachment(c._id, meta);
  return { character: c.name, ...meta };
}

export async function attachExistingAttachmentToBeat({ beat, attachmentId, caption }) {
  const file = await findAttachmentFile(attachmentId);
  if (!file) throw new Error(`Attachment not found: ${attachmentId}`);

  const beatDoc = await getBeat(beat);
  if (!beatDoc) throw new Error(`Beat not found: ${beat}`);

  const conflict = ownerConflictError(file, attachmentId, 'beat', (id) => id.equals(beatDoc._id));
  if (conflict === 'already_attached') {
    return {
      already_attached: true,
      beat: { _id: beatDoc._id, name: beatDoc.name },
      _id: file._id,
      filename: file.filename,
    };
  }
  if (conflict instanceof Error) throw conflict;

  await setAttachmentOwner(attachmentId, { ownerType: 'beat', ownerId: beatDoc._id });
  const meta = buildAttachmentMeta(file, caption);
  await pushBeatAttachment(beatDoc._id.toString(), meta);
  return { beat: { _id: beatDoc._id, name: beatDoc.name }, ...meta };
}

export async function attachExistingAttachmentToDirectorNote({ noteId, attachmentId, caption }) {
  const file = await findAttachmentFile(attachmentId);
  if (!file) throw new Error(`Attachment not found: ${attachmentId}`);

  const { notes = [] } = (await getDirectorNotes()) || {};
  const target = notes.find((n) => n._id?.toString() === String(noteId));
  if (!target) throw new Error(`Director note not found: ${noteId}`);

  const conflict = ownerConflictError(file, attachmentId, 'director_note', (id) =>
    id.equals(target._id),
  );
  if (conflict === 'already_attached') {
    return {
      already_attached: true,
      note_id: target._id,
      _id: file._id,
      filename: file.filename,
    };
  }
  if (conflict instanceof Error) throw conflict;

  await setAttachmentOwner(attachmentId, { ownerType: 'director_note', ownerId: target._id });
  const meta = buildAttachmentMeta(file, caption);
  await pushDirectorNoteAttachment(target._id.toString(), meta);
  return { note_id: target._id, ...meta };
}

export async function listCharacterAttachments(character) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  return { character: c.name, _id: c._id, attachments: c.attachments || [] };
}

export async function removeCharacterAttachment({ character, attachmentId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const oid = toObjectId(attachmentId);
  const has = (c.attachments || []).some((a) => a._id && a._id.equals(oid));
  if (!has) {
    throw new Error(`Attachment ${attachmentId} is not attached to ${c.name}`);
  }
  await deleteAttachment(oid);
  await getDb()
    .collection('characters')
    .updateOne(
      { _id: c._id },
      { $pull: { attachments: { _id: oid } }, $set: { updated_at: new Date() } },
    );
  return { character: c.name, removed: oid };
}
