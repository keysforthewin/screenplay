import { GridFSBucket, ObjectId } from 'mongodb';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from './client.js';
import {
  fetchImageFromUrl,
  validateImageBuffer,
  deriveImageFilename,
  extensionForType,
  toObjectId,
} from './imageBytes.js';
import { stripMarkdown } from '../util/markdown.js';
import { logger } from '../log.js';

const BUCKET_NAME = 'images';

function libraryNameLower(name) {
  return stripMarkdown(name || '').toLowerCase().trim();
}

let bucket;
function getBucket() {
  if (!bucket) bucket = new GridFSBucket(getDb(), { bucketName: BUCKET_NAME });
  return bucket;
}

export function filesCol() {
  return getDb().collection(`${BUCKET_NAME}.files`);
}

export function uploadBuffer({ buffer, filename, contentType, metadata }) {
  return new Promise((resolve, reject) => {
    const stream = getBucket().openUploadStream(filename, { contentType, metadata });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(buffer);
  });
}

export async function uploadGeneratedImage({
  buffer,
  contentType,
  prompt,
  generatedBy,
  ownerType = null,
  ownerId = null,
  filename,
  name = '',
  description = '',
}) {
  const sniffed = validateImageBuffer(buffer);
  const ct = contentType || sniffed;
  const finalFilename =
    filename?.trim() || `generated-${Date.now()}.${extensionForType(ct)}`;
  const metadata = {
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'generated',
    prompt: prompt || null,
    generated_by: generatedBy || null,
    name: String(name || ''),
    description: String(description || ''),
    name_lower: libraryNameLower(name),
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType: ct, metadata });
  logger.info(
    `mongo: gridfs upload owner=${ownerType || 'library'}/${ownerId || '-'} bytes=${buffer.length} source=generated`,
  );
  return {
    _id: id,
    filename: finalFilename,
    content_type: ct,
    size: buffer.length,
    metadata,
    uploaded_at: new Date(),
  };
}

export async function uploadImageFromUrl({
  sourceUrl,
  filename,
  ownerType = null,
  ownerId = null,
  name = '',
  description = '',
}) {
  const { buffer, contentType } = await fetchImageFromUrl(sourceUrl);
  const finalFilename = filename?.trim() || deriveImageFilename(sourceUrl, contentType);
  const metadata = {
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'upload',
    prompt: null,
    generated_by: null,
    name: String(name || ''),
    description: String(description || ''),
    name_lower: libraryNameLower(name),
  };
  const id = await uploadBuffer({ buffer, filename: finalFilename, contentType, metadata });
  logger.info(
    `mongo: gridfs upload owner=${ownerType || 'library'}/${ownerId || '-'} bytes=${buffer.length} source=url`,
  );
  return {
    _id: id,
    filename: finalFilename,
    content_type: contentType,
    size: buffer.length,
    metadata,
    uploaded_at: new Date(),
  };
}

export async function findImageFile(imageId) {
  return filesCol().findOne({ _id: toObjectId(imageId) });
}

export async function listLibraryImages() {
  return filesCol()
    .find({ 'metadata.owner_type': null, 'metadata.kind': { $ne: 'thumbnail' } })
    .sort({ uploadDate: -1 })
    .toArray();
}

export async function listImagesForBeat(beatId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'beat', 'metadata.owner_id': toObjectId(beatId) })
    .sort({ uploadDate: 1 })
    .toArray();
}

export async function listImagesForCharacter(characterId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'character', 'metadata.owner_id': toObjectId(characterId) })
    .sort({ uploadDate: 1 })
    .toArray();
}

export async function listImagesForDirectorNote(noteId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'director_note', 'metadata.owner_id': toObjectId(noteId) })
    .sort({ uploadDate: 1 })
    .toArray();
}

// All non-thumbnail GridFS images currently owned by entities of `ownerType`
// (e.g. 'character', 'beat', 'director_note'). Used by the picker modal's
// Character/Beats source tabs.
export async function listImagesByOwnerType(ownerType) {
  return filesCol()
    .find({ 'metadata.owner_type': ownerType, 'metadata.kind': { $ne: 'thumbnail' } })
    .sort({ uploadDate: -1 })
    .toArray();
}

export async function setImageOwner(imageId, { ownerType, ownerId }) {
  const oid = toObjectId(imageId);
  await filesCol().updateOne(
    { _id: oid },
    {
      $set: {
        'metadata.owner_type': ownerType,
        'metadata.owner_id': ownerId ? toObjectId(ownerId) : null,
      },
    },
  );
  logger.info(
    `mongo: gridfs owner_set image=${oid} owner=${ownerType || 'library'}/${ownerId || '-'}`,
  );
}

export async function deleteImage(imageId) {
  const oid = toObjectId(imageId);
  try {
    await getBucket().delete(oid);
    logger.info(`mongo: gridfs delete image=${oid}`);
  } catch (e) {
    if (e?.code !== 'ENOENT' && !/FileNotFound/i.test(e?.message || '')) throw e;
  }
}

export async function deleteImages(imageIds) {
  for (const id of imageIds || []) {
    if (id) await deleteImage(id);
  }
}

export function openImageDownloadStream(imageId) {
  return getBucket().openDownloadStream(toObjectId(imageId));
}

export async function readImageBuffer(imageId) {
  const file = await findImageFile(imageId);
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

export async function streamImageToTmp(imageId) {
  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);
  const ext = extensionForType(file.contentType);
  const dir = path.join(os.tmpdir(), 'screenplay-images');
  await fsp.mkdir(dir, { recursive: true });
  const filepath = path.join(dir, `${file._id.toString()}.${ext}`);
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

export function imageFileToMeta(file) {
  return {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType,
    size: file.length,
    source: file.metadata?.source || 'upload',
    prompt: file.metadata?.prompt || null,
    generated_by: file.metadata?.generated_by || null,
    name: file.metadata?.name || '',
    description: file.metadata?.description || '',
    uploaded_at: file.uploadDate,
  };
}

// Update the library-image-only metadata fields (name / description). Recomputes
// name_lower from stripped markdown whenever `name` is supplied so case-
// insensitive search keeps working. Refuses to touch images that are currently
// owned by an entity (owner_type !== null) — entity-scoped images use their
// own per-entity caption fields.
export async function setLibraryImageMeta(imageId, { name, description } = {}) {
  if (name === undefined && description === undefined) return { changed: false };
  const oid = toObjectId(imageId);
  const file = await filesCol().findOne({ _id: oid });
  if (!file) throw new Error(`Image not found: ${imageId}`);
  const ownerType = file.metadata?.owner_type;
  if (ownerType !== null && ownerType !== undefined) {
    throw new Error(`Image ${imageId} is owned by ${ownerType}; library metadata not applicable.`);
  }
  const set = {};
  if (name !== undefined) {
    set['metadata.name'] = String(name || '');
    set['metadata.name_lower'] = libraryNameLower(name);
  }
  if (description !== undefined) {
    set['metadata.description'] = String(description || '');
  }
  await filesCol().updateOne({ _id: oid }, { $set: set });
  return { changed: true, fields: Object.keys(set) };
}

// Update metadata fields on an image owned by an entity (character/beat/
// director_note). Mirrors setLibraryImageMeta but does NOT reject when
// owner_type !== null. Recomputes name_lower from stripped markdown when
// `name` is supplied for parity with the library search path.
export async function setOwnedImageMeta(imageId, { name, description } = {}) {
  if (name === undefined && description === undefined) return { changed: false };
  const oid = toObjectId(imageId);
  const file = await filesCol().findOne({ _id: oid });
  if (!file) throw new Error(`Image not found: ${imageId}`);
  const set = {};
  if (name !== undefined) {
    set['metadata.name'] = String(name || '');
    set['metadata.name_lower'] = libraryNameLower(name);
  }
  if (description !== undefined) {
    set['metadata.description'] = String(description || '');
  }
  await filesCol().updateOne({ _id: oid }, { $set: set });
  return { changed: true, fields: Object.keys(set) };
}

// Substring search across library images by metadata.name_lower and
// metadata.description. Done in JS rather than via $regex so the in-memory
// fake Mongo used in tests keeps working. listLibraryImages already filters
// out cached thumbnails (metadata.kind === 'thumbnail').
export async function searchLibraryImages({ query, limit = 20 } = {}) {
  const all = await listLibraryImages();
  const q = String(query || '').toLowerCase().trim();
  const filtered = q
    ? all.filter((f) => {
        const nameLower = (f.metadata?.name_lower || libraryNameLower(f.metadata?.name)).toLowerCase();
        const desc = (f.metadata?.description || '').toLowerCase();
        return nameLower.includes(q) || desc.includes(q);
      })
    : all;
  const cap = Math.max(1, Math.min(50, Number(limit) || 20));
  return filtered.slice(0, cap);
}

export async function ensureLibraryImageIndexes() {
  try {
    await filesCol().createIndex({ 'metadata.owner_type': 1, 'metadata.name_lower': 1 });
  } catch (e) {
    logger.warn(`mongo: ensureLibraryImageIndexes failed: ${e.message}`);
  }
}

export function ensureObjectId(id) {
  return id instanceof ObjectId ? id : toObjectId(id);
}
