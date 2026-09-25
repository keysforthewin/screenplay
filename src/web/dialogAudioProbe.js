// Probe the duration of a dialog line's recorded audio (GridFS attachments).
// Split out of gateway.js so mongo/dialogs.js can lazily backfill legacy rows
// without importing the whole gateway (which would create an import cycle).
import { readAttachmentBuffer } from '../mongo/attachments.js';
import { probeAudioDurationSeconds } from '../fal/videoPricing.js';

export async function probeDialogAudioDuration(audioFileId) {
  if (!audioFileId) return null;
  const read = await readAttachmentBuffer(audioFileId);
  if (!read?.buffer) return null;
  const mime = read.file?.contentType || read.file?.metadata?.content_type || null;
  const dur = await probeAudioDurationSeconds(read.buffer, mime);
  return dur && Number.isFinite(dur) && dur > 0 ? dur : null;
}
