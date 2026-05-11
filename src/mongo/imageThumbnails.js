import sharp from 'sharp';
import {
  filesCol,
  findImageFile,
  readImageBuffer,
  uploadBuffer,
} from './images.js';
import { toObjectId } from './imageBytes.js';
import { logger } from '../log.js';

const MAX_DIM = 600;
const JPEG_QUALITY = 80;

const inFlight = new Map();

export async function generateThumbnailBuffer(sourceBuffer) {
  return sharp(sourceBuffer)
    .rotate()
    .resize({
      width: MAX_DIM,
      height: MAX_DIM,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

export async function ensureThumbnailForImage(imageId) {
  const key = String(imageId);
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => {
    const orig = await findImageFile(imageId);
    if (!orig) throw new Error(`Image not found: ${imageId}`);
    if (orig.metadata?.kind === 'thumbnail') {
      return orig._id;
    }
    const existing = orig.metadata?.thumbnail_id;
    if (existing) {
      const cached = await findImageFile(existing);
      if (cached) return cached._id;
    }
    const read = await readImageBuffer(imageId);
    if (!read) throw new Error(`Image bytes not found: ${imageId}`);
    const thumbBuf = await generateThumbnailBuffer(read.buffer);
    const thumbId = await uploadBuffer({
      buffer: thumbBuf,
      filename: `${orig.filename || String(imageId)}.thumb.jpg`,
      contentType: 'image/jpeg',
      metadata: {
        kind: 'thumbnail',
        source_image_id: toObjectId(imageId),
        owner_type: null,
        owner_id: null,
      },
    });
    await filesCol().updateOne(
      { _id: toObjectId(imageId) },
      { $set: { 'metadata.thumbnail_id': thumbId } },
    );
    logger.info(
      `mongo: gridfs thumbnail generated source=${imageId} thumb=${thumbId} bytes=${thumbBuf.length}`,
    );
    return thumbId;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
