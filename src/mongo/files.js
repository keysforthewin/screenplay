import { getDb } from './client.js';
import { getCharacter, pushCharacterImage, pullCharacterImage } from './characters.js';
import { pullBeatImage } from './plots.js';
import { pullDirectorNoteImage } from './directorNotes.js';
import {
  uploadImageFromUrl,
  readImageBuffer,
  deleteImage,
  findImageFile,
  setImageOwner,
} from './images.js';
import { toObjectId } from './imageBytes.js';

// Detach an image from its current owner WITHOUT deleting the GridFS file.
// Used by the move-on-attach paths so attach_library_image_to_X tools can
// silently relocate an image that's already attached elsewhere.
//
// Returns:
//   null                                                if the image is a library image (owner_type null)
//   { prior_owner_type, prior_owner_id, prior_owner_name }  otherwise
//
// Swallows "not attached"/"not found" errors so stale metadata pointing at a
// deleted beat/character/note doesn't block the new attach.
export async function detachImageFromCurrentOwner(file) {
  const ownerType = file?.metadata?.owner_type;
  const ownerId = file?.metadata?.owner_id;
  if (!ownerType || !ownerId) return null;
  // The file's own stamp is the source of truth for which project the owner
  // lives in. Legacy files uploaded before the migration have no stamp; the
  // pull* helpers are lenient about unstamped docs, and post-migration every
  // file is stamped.
  const projectId = file?.metadata?.project_id;
  let priorName = null;
  try {
    if (ownerType === 'beat') {
      const res = await pullBeatImage(projectId, ownerId, file._id);
      priorName = res?.beat?.name || null;
    } else if (ownerType === 'character') {
      const res = await pullCharacterImage(projectId, ownerId, file._id);
      priorName = res?.character || null;
    } else if (ownerType === 'director_note') {
      await pullDirectorNoteImage(projectId, ownerId, file._id);
    }
  } catch (e) {
    if (!/not attached|not found/i.test(e?.message || '')) throw e;
  }
  return { prior_owner_type: ownerType, prior_owner_id: ownerId, prior_owner_name: priorName };
}

export async function attachImageToCharacter({ projectId, character, sourceUrl, filename, caption, setAsMain }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);

  const file = await uploadImageFromUrl(projectId ?? c.project_id, {
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

  const { is_main } = await pushCharacterImage(projectId, c._id.toString(), meta, setAsMain);
  return { character: c.name, ...meta, is_main };
}

export async function attachExistingImageToCharacter({ projectId, character, imageId, caption, setAsMain }) {
  const c = await getCharacter(projectId, character);
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

  const movedFrom = await detachImageFromCurrentOwner(file);

  await setImageOwner(imageId, { ownerType: 'character', ownerId: c._id });

  const meta = {
    _id: file._id,
    filename: file.filename,
    content_type: file.contentType,
    size: file.length,
    uploaded_at: file.uploadDate,
    caption: caption?.trim() || null,
  };

  const { is_main } = await pushCharacterImage(projectId, c._id.toString(), meta, setAsMain);
  return { character: c.name, ...meta, is_main, moved_from: movedFrom };
}

export async function listCharacterImages(projectId, character) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  return {
    character: c.name,
    images: c.images || [],
    main_image_id: c.main_image_id || null,
  };
}

export async function setMainCharacterImage({ projectId, character, imageId }) {
  const c = await getCharacter(projectId, character);
  if (!c) throw new Error(`Character not found: ${character}`);
  const oid = toObjectId(imageId);
  const inImages = (c.images || []).some((img) => img._id.equals(oid));
  const inArtworks = (c.artworks || []).some(
    (a) => a?.status === 'done' && a?.result_image_id && oid.equals(a.result_image_id),
  );
  if (!inImages && !inArtworks) {
    throw new Error(`Image ${imageId} is not attached to ${c.name}`);
  }
  await getDb()
    .collection('characters')
    .updateOne({ _id: c._id }, { $set: { main_image_id: oid, updated_at: new Date() } });
  return { character: c.name, main_image_id: oid };
}

export async function readCharacterImageBuffer(imageId) {
  return readImageBuffer(imageId);
}

export async function removeCharacterImage({ projectId, character, imageId }) {
  const c = await getCharacter(projectId, character);
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
