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
import { logger } from '../log.js';

const BUCKET_NAME = 'images';

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

export async function uploadGeneratedImage({
  buffer,
  contentType,
  prompt,
  generatedBy,
  ownerType = null,
  ownerId = null,
  filename,
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
}) {
  const { buffer, contentType } = await fetchImageFromUrl(sourceUrl);
  const finalFilename = filename?.trim() || deriveImageFilename(sourceUrl, contentType);
  const metadata = {
    owner_type: ownerType,
    owner_id: ownerId ? toObjectId(ownerId) : null,
    source: 'upload',
    prompt: null,
    generated_by: null,
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
    .find({ 'metadata.owner_type': null })
    .sort({ uploadDate: -1 })
    .toArray();
}

export async function listImagesForBeat(beatId) {
  return filesCol()
    .find({ 'metadata.owner_type': 'beat', 'metadata.owner_id': toObjectId(beatId) })
    .sort({ uploadDate: 1 })
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
    uploaded_at: file.uploadDate,
  };
}

export function ensureObjectId(id) {
  return id instanceof ObjectId ? id : toObjectId(id);
}
