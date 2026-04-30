import { getDb } from './client.js';
import { getCharacter } from './characters.js';
import {
  uploadImageFromUrl,
  readImageBuffer,
  deleteImage,
} from './images.js';
import { toObjectId } from './imageBytes.js';

export async function attachImageToCharacter({ character, sourceUrl, filename, caption, setAsMain }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);

  const file = await uploadImageFromUrl({
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
    uploaded_at: file.uploaded_at,
    caption: caption?.trim() || null,
  };

  const promoteToMain = !!setAsMain || !c.images || c.images.length === 0;
  const update = {
    $push: { images: meta },
    $set: { updated_at: new Date(), ...(promoteToMain ? { main_image_id: file._id } : {}) },
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

export async function readCharacterImageBuffer(imageId) {
  return readImageBuffer(imageId);
}

export async function removeCharacterImage({ character, imageId }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const oid = toObjectId(imageId);
  const images = c.images || [];
  if (!images.some((img) => img._id.equals(oid))) {
    throw new Error(`Image ${imageId} is not attached to ${c.name}`);
  }

  await deleteImage(oid);

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
