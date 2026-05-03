import { getDb } from './client.js';
import { getCharacter, pushCharacterImage } from './characters.js';
import {
  uploadImageFromUrl,
  readImageBuffer,
  deleteImage,
  findImageFile,
  setImageOwner,
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

  const { is_main } = await pushCharacterImage(c._id.toString(), meta, setAsMain);
  return { character: c.name, ...meta, is_main };
}

export async function attachExistingImageToCharacter({ character, imageId, caption, setAsMain }) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);

  const file = await findImageFile(imageId);
  if (!file) throw new Error(`Image not found: ${imageId}`);

  if (
    file.metadata?.owner_type === 'character' &&
    file.metadata?.owner_id &&
    file.metadata.owner_id.equals(c._id)
  ) {
    return {
      already_attached: true,
      character: c.name,
      _id: file._id,
      filename: file.filename,
      content_type: file.contentType,
      size: file.length,
    };
  }
  if (file.metadata?.owner_type === 'character') {
    throw new Error(
      `Image ${imageId} is currently attached to a different character. Detach it first with remove_character_image.`,
    );
  }
  if (file.metadata?.owner_type && file.metadata.owner_type !== null) {
    throw new Error(
      `Image ${imageId} is currently attached to a ${file.metadata.owner_type}. Detach it first.`,
    );
  }

  await setImageOwner(imageId, { ownerType: 'character', ownerId: c._id });

  const meta = {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType,
    size: file.length,
    uploaded_at: file.uploadDate,
    caption: caption?.trim() || null,
  };

  const { is_main } = await pushCharacterImage(c._id.toString(), meta, setAsMain);
  return { character: c.name, ...meta, is_main };
}

export async function listCharacterImages(character) {
  const c = await getCharacter(character);
  if (!c) throw new Error(`Character not found: ${character}`);
  return {
    character: c.name,
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
