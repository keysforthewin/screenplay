import { GridFSBucket } from 'mongodb';
import { getDb } from './client.js';
import { getCharacter } from './characters.js';
import {
  fetchImageFromUrl,
  deriveImageFilename,
  toObjectId,
} from './imageBytes.js';

const BUCKET_NAME = 'character_images';

let bucket;
function getBucket() {
  if (!bucket) bucket = new GridFSBucket(getDb(), { bucketName: BUCKET_NAME });
  return bucket;
}

function uploadBuffer({ buffer, filename, contentType, characterId }) {
  return new Promise((resolve, reject) => {
    const stream = getBucket().openUploadStream(filename, {
      contentType,
      metadata: { character_id: characterId },
    });
    stream.on('error', reject);
    stream.on('finish', () => resolve(stream.id));
    stream.end(buffer);
  });
}

export async function attachImageToCharacter({ character, sourceUrl, filename, caption, setAsMain }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);

  const { buffer, contentType } = await fetchImageFromUrl(sourceUrl);
  const finalFilename = filename?.trim() || deriveImageFilename(sourceUrl, contentType);
  const fileId = await uploadBuffer({
    buffer,
    filename: finalFilename,
    contentType,
    characterId: c._id,
  });

  const meta = {
    _id: fileId,
    filename: finalFilename,
    content_type: contentType,
    size: buffer.length,
    uploaded_at: new Date(),
    caption: caption?.trim() || null,
  };

  const promoteToMain = !!setAsMain || !c.images || c.images.length === 0;
  const update = {
    $push: { images: meta },
    $set: { updated_at: new Date(), ...(promoteToMain ? { main_image_id: fileId } : {}) },
  };
  await getDb().collection('characters').updateOne({ _id: c._id }, update);
  return { ...meta, is_main: promoteToMain };
}

export async function listCharacterImages(character) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  return {
    images: c.images || [],
    main_image_id: c.main_image_id || null,
  };
}

export async function setMainCharacterImage({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const oid = toObjectId(imageId);
  const found = (c.images || []).some((img) => img._id.equals(oid));
  if (!found) throw new Error(`Image ${imageId} is not attached to ${c.name}`);
  await getDb()
    .collection('characters')
    .updateOne({ _id: c._id }, { $set: { main_image_id: oid, updated_at: new Date() } });
  return { character: c.name, main_image_id: oid };
}

export async function removeCharacterImage({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const oid = toObjectId(imageId);
  const images = c.images || [];
  if (!images.some((img) => img._id.equals(oid))) {
    throw new Error(`Image ${imageId} is not attached to ${c.name}`);
  }

  try {
    await getBucket().delete(oid);
  } catch (e) {
    if (e?.code !== 'ENOENT' && !/FileNotFound/i.test(e?.message || '')) throw e;
  }

  const remaining = images.filter((img) => !img._id.equals(oid));
  const wasMain = c.main_image_id && c.main_image_id.equals(oid);
  const newMain = wasMain ? remaining[0]?._id || null : c.main_image_id || null;

  await getDb()
    .collection('characters')
    .updateOne(
      { _id: c._id },
      {
        $pull: { images: { _id: oid } },
        $set: { main_image_id: newMain, updated_at: new Date() },
      },
    );
  return { character: c.name, removed: oid, main_image_id: newMain };
}
