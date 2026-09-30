// Dialogue recordings → the audio a lip-sync render receives. Shared by the
// Storyboard tab's beat render (beatRender.js) and the Prompts tab's cut
// renders (comfyVideoGenerate.js, cutBeatRender.js).
//
// Real voices only: the audio is the concatenation of the covered lines'
// recordings, joined with short gaps and a tail. Dialogue words never enter a
// prompt. `covered` is the row's dialog docs (its dialog_ids resolved against
// the beat's dialogue), in script order.

import { readAttachmentBuffer, uploadAttachmentBuffer } from '../mongo/attachments.js';
import { concatAudioToMp3 } from './audioTranscode.js';

export const CONCAT_GAP_SECONDS = 0.25;
export const CONCAT_TAIL_SECONDS = 0.3;

const sid = (x) => (x == null ? null : x.toString?.() || String(x));

// The dialogue docs a storyboard row or cut covers (its dialog_ids), in the
// order the beat's dialogue list has them.
export function coveredDialogsFor(row, dialogs) {
  const wanted = new Set((row?.dialog_ids || []).map(sid));
  if (!wanted.size) return [];
  return (dialogs || []).filter((d) => wanted.has(sid(d._id)));
}

export function allLinesRecorded(covered) {
  return covered.length > 0 && covered.every((d) => d.audio_file_id);
}

// The joined recordings' length: each line's probed duration plus the gaps
// and the tail concatAudioToMp3 adds.
export function speechSecondsFor(covered) {
  let total = 0;
  for (const d of covered) total += Number(d.audio_duration_seconds) || 0;
  if (covered.length > 1) total += CONCAT_GAP_SECONDS * (covered.length - 1) + CONCAT_TAIL_SECONDS;
  return total;
}

// 1-based line numbers as the planner shows them (list position), for the
// covered docs that have no recording.
export function unrecordedLineNumbers(covered, dialogs) {
  const all = dialogs || [];
  return covered
    .filter((d) => !d.audio_file_id)
    .map((d) => {
      const i = all.findIndex((x) => sid(x._id) === sid(d._id));
      return i >= 0 ? i + 1 : '?';
    });
}

// Read every covered recording, join them into one MP3 and upload it as a
// beat-owned attachment. Returns { buffer, file, lineCount, speechSeconds }.
// The caller points its row at `file` (setStoryboardAudioViaGateway /
// setVideoPromptAudioViaGateway, which probe the real duration).
export async function buildCoveredDialogueAudio({ projectId, beatId, covered, filename }) {
  const buffers = [];
  for (const d of covered) {
    const read = await readAttachmentBuffer(d.audio_file_id);
    if (!read?.buffer?.length) throw new Error(`Recording for line ${d.order ?? sid(d._id)} could not be read.`);
    buffers.push(read.buffer);
  }
  if (!buffers.length) throw new Error('No recordings to join.');
  const buffer = await concatAudioToMp3(buffers, { gapSeconds: CONCAT_GAP_SECONDS, tailSeconds: CONCAT_TAIL_SECONDS });
  const file = await uploadAttachmentBuffer(projectId, {
    buffer,
    filename: filename || `dialogue-${Date.now()}.mp3`,
    contentType: 'audio/mpeg',
    ownerType: 'beat',
    ownerId: beatId,
    generatedBy: 'dialog-concat',
  });
  return { buffer, file, lineCount: covered.length, speechSeconds: speechSecondsFor(covered) };
}

// Run `worker(item, index)` over `items` with at most `concurrency` in flight.
export async function runPool(items, concurrency, worker) {
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = Array.from({ length: n }, async () => {
    while (next < items.length) {
      const idx = next++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}
