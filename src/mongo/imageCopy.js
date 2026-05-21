// Helper for duplicating a source GridFS image into a brand-new file owned
// by a target entity. Lives in its own module (rather than inside images.js)
// so its calls to readImageBuffer / uploadGeneratedImage go through the
// images.js module boundary — keeping the existing vitest mocks effective.

import { readImageBuffer, uploadGeneratedImage } from './images.js';

// Used by cross-entity picks and the artwork-import flow. The source image
// is left untouched; the new owner gets an independent copy with its own
// GridFS id and metadata. Returns the embedded-gallery meta entry shape.
export async function copyImageToNewOwner({
  imageId,
  ownerType,
  ownerId,
  filenameBase,
}) {
  const src = await readImageBuffer(imageId);
  if (!src) {
    const e = new Error(`source image not found: ${imageId}`);
    e.status = 404;
    throw e;
  }
  const { buffer, file } = src;
  const contentType =
    file.contentType || file.metadata?.content_type || 'image/png';
  const ext = (() => {
    if (contentType.includes('jpeg')) return 'jpg';
    if (contentType.includes('webp')) return 'webp';
    return 'png';
  })();
  const newFile = await uploadGeneratedImage({
    buffer,
    contentType,
    ownerType,
    ownerId,
    filename: `${filenameBase}-${Date.now()}.${ext}`,
    prompt: file.metadata?.prompt || null,
    generatedBy: file.metadata?.generated_by || null,
    name: file.metadata?.name || '',
    description: file.metadata?.description || '',
  });
  return {
    _id: newFile._id,
    filename: newFile.filename,
    content_type: newFile.content_type,
    size: newFile.size,
    source: file.metadata?.source || 'upload',
    prompt: newFile.metadata?.prompt || null,
    generated_by: newFile.metadata?.generated_by || null,
    uploaded_at: newFile.uploaded_at,
  };
}
