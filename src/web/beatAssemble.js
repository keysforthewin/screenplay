// Join a beat's rendered shot clips into one MP4 (src/web/beatRender.js calls
// this once every shot has a video). Straight cuts only: each clip is first
// normalized to a common format (fal endpoints return different sizes, frame
// rates, and some are silent), then the concat demuxer stream-copies them
// together. The pair loop in assembleBeatVideo is the seam for a later
// xfade/acrossfade on `transition_in`.
//
// ffmpeg + ffprobe must be on PATH; ENOENT surfaces as FfmpegMissingError so
// the route/agent can say so plainly. Everything goes through one spawn seam
// (__setAssembleSpawnImplForTests) so tests can assert the argument lists and
// fake the output files without a binary.

import { spawn } from 'child_process';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '../log.js';
import { streamAttachmentToTmp, uploadAttachmentBuffer } from '../mongo/attachments.js';
import { setBeatVideoViaGateway } from './gateway.js';

export const ASSEMBLE_WIDTH = 1920;
export const ASSEMBLE_HEIGHT = 1080;
export const ASSEMBLE_FPS = 24;
export const ASSEMBLE_CRF = 20;
export const ASSEMBLE_AUDIO_RATE = 48000;

export class FfmpegMissingError extends Error {
  constructor(bin = 'ffmpeg') {
    super(`${bin} is not installed on the server (binary not found on PATH).`);
    this.name = 'FfmpegMissingError';
    this.code = 'FFMPEG_MISSING';
  }
}

export class BeatAssembleError extends Error {
  constructor(message) {
    super(`beat assembly failed: ${message}`);
    this.name = 'BeatAssembleError';
    this.code = 'BEAT_ASSEMBLE_FAILED';
  }
}

// Seam: ({ bin, args }) → Promise<{ stdout }>. Rejects with FfmpegMissingError
// on ENOENT and BeatAssembleError on a non-zero exit.
let spawnImpl = defaultSpawn;
export function __setAssembleSpawnImplForTests(fn) {
  spawnImpl = fn || defaultSpawn;
}

function defaultSpawn({ bin, args }) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new BeatAssembleError(e?.message || String(e)));
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => {
      if (stdout.length < 65536) stdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      if (stderr.length < 4096) stderr += c.toString();
    });
    proc.on('error', (e) => {
      if (e?.code === 'ENOENT') reject(new FfmpegMissingError(bin));
      else reject(new BeatAssembleError(e?.message || String(e)));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new BeatAssembleError(stderr.trim().slice(-300) || `${bin} exit code ${code}`));
    });
  });
}

// Does the clip carry an audio stream? Silent clips get a generated silent
// track so every segment has the same stream layout for the concat demuxer.
export async function probeHasAudio(inputPath) {
  const { stdout } = await spawnImpl({
    bin: 'ffprobe',
    args: ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', inputPath],
  });
  return /audio/.test(String(stdout || ''));
}

export async function probeDurationSeconds(inputPath) {
  try {
    const { stdout } = await spawnImpl({
      bin: 'ffprobe',
      args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath],
    });
    const n = Number(String(stdout || '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Scale to fit inside 1920x1080 (letter/pillar-box, never crop), 24 fps,
// yuv420p H.264, AAC stereo 48k. Silent inputs get anullsrc mixed in,
// trimmed to the video with -shortest.
export function normalizeArgs({ inputPath, outputPath, hasAudio }) {
  const vf =
    `scale=${ASSEMBLE_WIDTH}:${ASSEMBLE_HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${ASSEMBLE_WIDTH}:${ASSEMBLE_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${ASSEMBLE_FPS},format=yuv420p`;
  const args = ['-i', inputPath];
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${ASSEMBLE_AUDIO_RATE}`);
  }
  args.push(
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(ASSEMBLE_CRF),
    '-c:a', 'aac', '-ar', String(ASSEMBLE_AUDIO_RATE), '-ac', '2', '-b:a', '192k',
  );
  if (!hasAudio) args.push('-shortest');
  args.push('-movflags', '+faststart', '-y', outputPath);
  return args;
}

export function concatArgs({ listPath, outputPath }) {
  return ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath];
}

async function safeRm(p) {
  if (!p) return;
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// shots: the beat's storyboard rows in order, each with video_file_id set.
// Returns { file, durationSeconds } and points the beat at the new video via
// the gateway (which deletes the previous one). Throws on any missing clip.
export async function assembleBeatVideo({ projectId, beat, shots, onProgress = null }) {
  const ordered = [...(shots || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!ordered.length) throw new BeatAssembleError('no shots to assemble');
  const missing = ordered.filter((s) => !s.video_file_id);
  if (missing.length) {
    throw new BeatAssembleError(
      `${missing.length} shot${missing.length === 1 ? '' : 's'} without a rendered clip (shot ${missing.map((s) => (s.order ?? 0) + 1).join(', ')})`,
    );
  }
  const progress = (message) => {
    try {
      onProgress?.(message);
    } catch {
      // observers never fail assembly
    }
  };

  const workDir = path.join(os.tmpdir(), 'screenplay-beat-assemble', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(workDir, { recursive: true });
  const downloaded = [];
  try {
    const segmentPaths = [];
    for (let i = 0; i < ordered.length; i++) {
      const sb = ordered[i];
      progress(`Normalizing clip ${i + 1}/${ordered.length}`);
      const { path: inputPath } = await streamAttachmentToTmp(sb.video_file_id);
      downloaded.push(inputPath);
      const hasAudio = await probeHasAudio(inputPath);
      const outputPath = path.join(workDir, `seg-${String(i).padStart(3, '0')}.mp4`);
      await spawnImpl({ bin: 'ffmpeg', args: normalizeArgs({ inputPath, outputPath, hasAudio }) });
      segmentPaths.push(outputPath);
    }

    // Straight cuts. A future transition pass would replace this list with
    // xfade/acrossfade filter graphs over (segment[i-1], segment[i]) driven by
    // ordered[i].transition_in.
    const listPath = path.join(workDir, 'list.txt');
    await fsp.writeFile(
      listPath,
      segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n',
    );
    const outputPath = path.join(workDir, 'beat.mp4');
    progress(`Joining ${segmentPaths.length} clips`);
    await spawnImpl({ bin: 'ffmpeg', args: concatArgs({ listPath, outputPath }) });

    let buffer;
    try {
      buffer = await fsp.readFile(outputPath);
    } catch (e) {
      throw new BeatAssembleError(`output missing after ffmpeg exit 0: ${e?.message || e}`);
    }
    if (!buffer.length) throw new BeatAssembleError('output file is empty');

    const probed = await probeDurationSeconds(outputPath);
    const summed = ordered.reduce((sum, s) => sum + (Number(s.video_duration_seconds) || 0), 0);
    const durationSeconds = probed || (summed > 0 ? summed : null);

    progress('Saving beat video');
    const file = await uploadAttachmentBuffer(projectId, {
      buffer,
      filename: `beat-${beat._id}-video-${Date.now()}.mp4`,
      contentType: 'video/mp4',
      ownerType: 'beat',
      ownerId: beat._id,
      generatedBy: 'beat-assemble',
    });
    await setBeatVideoViaGateway({ projectId, beatId: beat._id, fileId: file._id, durationSeconds });
    logger.info(`beat assemble: beat=${beat._id} clips=${ordered.length} file=${file._id} duration=${durationSeconds ?? '?'}s`);
    return { file, durationSeconds };
  } finally {
    await safeRm(workDir);
    for (const p of downloaded) await safeRm(p);
  }
}
