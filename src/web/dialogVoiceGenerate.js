// "Generate all voices" for a beat's dialogue: every line whose speaker has an
// ElevenLabs voice (its own — dialogs.eleven_voice — else its character's) is rendered with Eleven v4 and
// stored as that line's audio — the same slot a recording or an upload fills.
//
// One in-memory job per beat (a restart ends it). The job holds the beat's
// dialog lock, so Generate / Edit / Delete all answer 409 while it runs. Each
// line is re-read right before its turn (a line deleted, emptied or re-cast
// meanwhile is skipped), a failed line is recorded and the job carries on.
// Lines that already have audio are left alone unless `overwrite` is set —
// a recorded performance is never replaced by accident.

import { ObjectId } from 'mongodb';
import * as eleven from '../eleven/client.js';
import {
  DIALOG_TTS_MAX_CHARS,
  DIALOG_TTS_MODEL,
  dialogSpeechText,
  stripAudioTags,
} from '../eleven/dialogTags.js';
import { logger } from '../log.js';
import { uploadAttachmentBuffer } from '../mongo/attachments.js';
import { getDialog, listDialogs } from '../mongo/dialogs.js';
import { getBeat } from '../mongo/plots.js';
import { stripMarkdown } from '../util/markdown.js';
import { isBeatLocked, withBeatLock } from './beatLocks.js';
import { loadVoiceCast, voiceForDialog } from './dialogVoices.js';
import { setDialogAudioViaGateway } from './gateway.js';

const CONCURRENCY = 2;

const jobsByBeat = new Map(); // beat id → the beat's latest job

export class DialogVoiceError extends Error {
  constructor(message, { code, status }) {
    super(message);
    this.name = 'DialogVoiceError';
    this.code = code;
    this.status = status;
  }
}

function label(dialog, index) {
  const speaker = stripMarkdown(dialog.character || '').trim() || '(no speaker)';
  return `${index + 1}. ${speaker}`;
}

// Why a line cannot (or need not) be voiced, else null. `voice` is the
// speaker's cast entry.
function skipReason(dialog, voice, { overwrite }) {
  if (!voice) return 'no ElevenLabs voice assigned';
  if (!stripAudioTags(dialogSpeechText(dialog.body))) return 'empty line';
  if (dialog.audio_file_id && !overwrite) return 'already has audio';
  return null;
}

// What the confirm dialog shows before anything is spent.
export async function previewDialogVoices({ projectId, beatId }) {
  const dialogs = await listDialogs({ beatId });
  const cast = await loadVoiceCast(projectId);
  let ready = 0;
  let withAudio = 0;
  let noVoice = 0;
  let empty = 0;
  let characters = 0;
  const unvoiced = new Set();
  for (const d of dialogs) {
    const voice = voiceForDialog(cast, d);
    const text = dialogSpeechText(d.body);
    if (!voice) {
      noVoice += 1;
      const s = stripMarkdown(d.character || '').trim();
      if (s) unvoiced.add(s);
    } else if (!stripAudioTags(text)) {
      empty += 1;
    } else {
      characters += text.length;
      if (d.audio_file_id) withAudio += 1;
      else ready += 1;
    }
  }
  return {
    configured: eleven.isConfigured(),
    model: DIALOG_TTS_MODEL,
    total: dialogs.length,
    ready,
    with_audio: withAudio,
    no_voice: noVoice,
    empty,
    characters,
    unvoiced_speakers: [...unvoiced],
  };
}

export function serializeDialogVoiceJob(job) {
  if (!job) return null;
  const counts = { queued: 0, running: 0, done: 0, error: 0, skipped: 0, cancelled: 0 };
  for (const it of job.items) counts[it.status] = (counts[it.status] || 0) + 1;
  return {
    job_id: job.job_id,
    beat_id: job.beat_id,
    status: job.status,
    model: job.model,
    overwrite: job.overwrite,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    counts,
    items: job.items,
  };
}

export function getDialogVoiceJobForBeat(beatId) {
  return jobsByBeat.get(String(beatId)) || null;
}

export function cancelDialogVoiceJob(beatId) {
  const job = getDialogVoiceJobForBeat(beatId);
  if (!job || job.status !== 'running') return null;
  job.cancel_requested = true;
  return job;
}

export async function startDialogVoiceJob({ projectId, beatId, overwrite = false }) {
  if (!eleven.isConfigured()) {
    throw new DialogVoiceError('ElevenLabs is not configured on the server (ELEVEN_LABS_KEY missing).', {
      code: 'ELEVEN_NOT_CONFIGURED', status: 503,
    });
  }
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new DialogVoiceError('beat not found', { code: 'NOT_FOUND', status: 404 });
  const key = beat._id.toString();
  if (isBeatLocked(beat._id)) {
    throw new DialogVoiceError('Dialog work in progress for this beat; try again', {
      code: 'BEAT_BUSY', status: 409,
    });
  }

  const dialogs = await listDialogs({ beatId: beat._id });
  const cast = await loadVoiceCast(projectId);
  const items = dialogs.map((d, i) => {
    const voice = voiceForDialog(cast, d);
    const reason = skipReason(d, voice, { overwrite });
    return {
      dialog_id: d._id.toString(),
      label: label(d, i),
      voice_name: voice?.voice_name || null,
      status: reason ? 'skipped' : 'queued',
      reason,
      error: null,
    };
  });
  if (!items.some((it) => it.status === 'queued')) {
    const why = !dialogs.length
      ? 'This beat has no dialogue.'
      : items.every((it) => it.reason === 'no ElevenLabs voice assigned')
        ? 'No speaker in this beat has an ElevenLabs voice. Pick one on each character\'s page, or on the line itself.'
        : 'Nothing to generate: every line with a voice already has audio.';
    throw new DialogVoiceError(why, { code: 'NOTHING_TO_GENERATE', status: 400 });
  }

  const job = {
    job_id: new ObjectId().toString(),
    beat_id: key,
    status: 'running',
    model: DIALOG_TTS_MODEL,
    overwrite: Boolean(overwrite),
    started_at: new Date(),
    finished_at: null,
    error: null,
    cancel_requested: false,
    items,
  };
  jobsByBeat.set(key, job);
  withBeatLock(beat._id, () => runJob({ job, projectId, overwrite })).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finished_at = new Date();
    logger.error(`dialog voice job ${job.job_id} crashed: ${e.message}`);
  });
  return job;
}

async function runJob({ job, projectId, overwrite }) {
  const queue = job.items.filter((it) => it.status === 'queued');
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const item = queue[next++];
      if (job.cancel_requested) {
        item.status = 'cancelled';
        continue;
      }
      item.status = 'running';
      try {
        await voiceOneLine({ item, projectId, overwrite });
      } catch (e) {
        item.status = 'error';
        item.error = e?.message || String(e);
        logger.warn(`dialog voice job ${job.job_id} line ${item.label} failed: ${item.error}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  job.status = job.cancel_requested ? 'cancelled' : 'done';
  job.finished_at = new Date();
  const c = serializeDialogVoiceJob(job).counts;
  logger.info(
    `dialog voice job ${job.job_id} ${job.status} done=${c.done} error=${c.error} skipped=${c.skipped} cancelled=${c.cancelled}`,
  );
}

async function voiceOneLine({ item, projectId, overwrite }) {
  // Re-read: the line and the cast may have changed since the job was queued.
  const dialog = await getDialog(projectId, item.dialog_id);
  if (!dialog) {
    item.status = 'skipped';
    item.reason = 'line was deleted';
    return;
  }
  const cast = await loadVoiceCast(projectId);
  const voice = voiceForDialog(cast, dialog);
  const reason = skipReason(dialog, voice, { overwrite });
  if (reason) {
    item.status = 'skipped';
    item.reason = reason;
    return;
  }
  const text = dialogSpeechText(dialog.body);
  if (text.length > DIALOG_TTS_MAX_CHARS) {
    throw new Error(`line too long for ${DIALOG_TTS_MODEL} (${text.length} > ${DIALOG_TTS_MAX_CHARS} characters)`);
  }
  item.voice_name = voice.voice_name || null;
  const { buffer, contentType } = await eleven.textToSpeech({
    voiceId: voice.voice_id,
    text,
    modelId: DIALOG_TTS_MODEL,
  });
  const file = await uploadAttachmentBuffer(projectId, {
    buffer,
    filename: `dialog-${item.dialog_id}-${DIALOG_TTS_MODEL}-${Date.now()}.mp3`,
    contentType: contentType || 'audio/mpeg',
    ownerType: 'dialog',
    ownerId: dialog._id,
    prompt: text.slice(0, 500),
    generatedBy: `elevenlabs/${DIALOG_TTS_MODEL}`,
  });
  await setDialogAudioViaGateway({ projectId, dialogId: item.dialog_id, audioFileId: file._id });
  item.status = 'done';
}

export function _resetDialogVoiceJobsForTests() {
  jobsByBeat.clear();
}
