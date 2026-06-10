// Helper for duplicating a source GridFS attachment into a brand-new file with
// a different owner. Lives in its own module (rather than inside attachments.js)
// so its calls to readAttachmentBuffer / uploadAttachmentBuffer go through the
// attachments.js module boundary — keeping vitest mocks effective, mirroring
// the imageCopy.js / images.js split on the image side.

import { readAttachmentBuffer, uploadAttachmentBuffer } from './attachments.js';

// Copies stay in the source attachment's project unless the caller pins one.
// Returns the same metadata shape as uploadAttachmentBuffer.
export async function copyAttachmentBuffer({
  projectId,
  sourceFileId,
  filename,
  ownerType = null,
  ownerId = null,
}) {
  const read = await readAttachmentBuffer(sourceFileId);
  if (!read) throw new Error(`Attachment not found: ${sourceFileId}`);
  const { buffer, file } = read;
  const ct =
    file.contentType || file.metadata?.content_type || 'application/octet-stream';
  const finalFilename =
    filename?.trim() || file.filename || `copy-${Date.now()}.bin`;
  // Explicit projectId pin wins; otherwise fall back to source file's project.
  const targetProjectId = projectId || file.metadata?.project_id || undefined;
  return uploadAttachmentBuffer(targetProjectId, {
    buffer,
    filename: finalFilename,
    contentType: ct,
    ownerType,
    ownerId,
  });
}
