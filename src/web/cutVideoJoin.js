// "Download all videos" for one beat's Scenes tab: every cut's clip, in page
// order, joined by ffmpeg into one MP4 the browser downloads. Straight cuts:
// each clip is first normalized to the FIRST clip's size and frame rate
// (models return different sizes and rates, and some clips are silent), then
// the concat demuxer stream-copies the segments together.
//
// Nothing is stored: the MP4 is a tmp file that lives as long as its job
// (JOB_RETENTION_MS). ffmpeg + ffprobe must be on PATH; ENOENT surfaces as
// FfmpegMissingError. Everything goes through one spawn seam
// (_setJoinSpawnImplForTests).

import { spawn } from 'child_process';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ObjectId } from 'mongodb';
import { logger } from '../log.js';
import { getBeat } from '../mongo/plots.js';
import { streamAttachmentToTmp } from '../mongo/attachments.js';
import { listVideoPrompts } from '../mongo/videoPrompts.js';
import { listVideoScenes } from '../mongo/videoScenes.js';
import { stripMarkdown } from '../util/markdown.js';
import { orderedCutsWithLabels } from './cutVideoBatch.js';

const FALLBACK_FORMAT = { width: 1920, height: 1080, fps: '24' };
const JOIN_CRF = 18;
const JOIN_AUDIO_RATE = 48000;
const JOB_RETENTION_MS = 60 * 60 * 1000;

export class FfmpegMissingError extends Error {
  constructor(bin = 'ffmpeg') {
    super(`${bin} is not installed on the server (binary not found on PATH).`);
    this.name = 'FfmpegMissingError';
    this.code = 'FFMPEG_MISSING';
  }
}

export class CutVideoJoinError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'CutVideoJoinError';
    this.code = 'CUT_VIDEO_JOIN';
    this.status = status;
  }
}

// Seam: ({ bin, args }) → Promise<{ stdout }>.
let spawnImpl = defaultSpawn;
export function _setJoinSpawnImplForTests(fn) {
  spawnImpl = fn || defaultSpawn;
}

function defaultSpawn({ bin, args }) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error(e?.message || String(e)));
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => {
      if (stdout.length < 65536) stdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      // Keep the tail: ffmpeg's banner comes first, the reason last.
      stderr = (stderr + c.toString()).slice(-4096);
    });
    proc.on('error', (e) => {
      if (e?.code === 'ENOENT') reject(new FfmpegMissingError(bin));
      else reject(new Error(e?.message || String(e)));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr.trim().slice(-300) || `${bin} exit code ${code}`));
    });
  });
}

async function probe(inputPath, args) {
  const { stdout } = await spawnImpl({ bin: 'ffprobe', args: ['-v', 'error', ...args, '-of', 'csv=p=0', inputPath] });
  return String(stdout || '').trim();
}

export async function probeHasAudio(inputPath) {
  return /audio/.test(await probe(inputPath, ['-select_streams', 'a', '-show_entries', 'stream=codec_type']));
}

// "1280,720,24/1" → { width, height, fps } with even dimensions; the fallback
// when the probe says nothing usable.
export function parseVideoFormat(csv) {
  const [w, h, rate] = String(csv || '').split(/[,\n]/).map((s) => s.trim());
  const even = (n) => Math.floor(Number(n) / 2) * 2;
  const width = even(w);
  const height = even(h);
  if (!(width >= 16) || !(height >= 16)) return { ...FALLBACK_FORMAT };
  const m = /^(\d+)(?:\/(\d+))?$/.exec(rate || '');
  const value = m ? Number(m[1]) / Number(m[2] || 1) : NaN;
  return { width, height, fps: value >= 8 && value <= 120 ? rate : FALLBACK_FORMAT.fps };
}

async function probeVideoFormat(inputPath) {
  try {
    return parseVideoFormat(await probe(inputPath, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate']));
  } catch (e) {
    if (e instanceof FfmpegMissingError) throw e;
    return { ...FALLBACK_FORMAT };
  }
}

async function probeDurationSeconds(inputPath) {
  try {
    const n = Number(await probe(inputPath, ['-show_entries', 'format=duration']));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// Fit inside the target frame (letter/pillar-box, never crop), yuv420p H.264,
// AAC stereo. A silent clip gets a generated silent track so every segment
// has the same stream layout for the concat demuxer.
export function normalizeArgs({ inputPath, outputPath, hasAudio, format }) {
  const { width, height, fps } = format;
  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
  const args = ['-i', inputPath];
  if (!hasAudio) args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${JOIN_AUDIO_RATE}`);
  args.push(
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(JOIN_CRF),
    '-c:a', 'aac', '-ar', String(JOIN_AUDIO_RATE), '-ac', '2', '-b:a', '192k',
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

// clips: [{ video_file_id, label }] in order. Writes the joined MP4 to
// `outputPath` and returns { durationSeconds, clipCount }.
export async function joinClips({ clips, outputPath, onProgress = null }) {
  if (!clips?.length) throw new CutVideoJoinError('No videos to join');
  const workDir = path.join(os.tmpdir(), 'screenplay-cut-join', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(workDir, { recursive: true });
  const downloaded = [];
  try {
    const segments = [];
    let format = null;
    for (let i = 0; i < clips.length; i++) {
      onProgress?.(`Preparing clip ${i + 1} of ${clips.length}`);
      const { path: inputPath } = await streamAttachmentToTmp(clips[i].video_file_id);
      downloaded.push(inputPath);
      if (!format) format = await probeVideoFormat(inputPath);
      const hasAudio = await probeHasAudio(inputPath);
      const segPath = path.join(workDir, `seg-${String(i).padStart(4, '0')}.mp4`);
      try {
        await spawnImpl({ bin: 'ffmpeg', args: normalizeArgs({ inputPath, outputPath: segPath, hasAudio, format }) });
      } catch (e) {
        if (e instanceof FfmpegMissingError) throw e;
        throw new CutVideoJoinError(`Cut ${clips[i].label}: ${e?.message || e}`, { status: 500 });
      }
      segments.push(segPath);
      // The source is no longer needed; a long beat should not hold them all.
      await safeRm(inputPath);
    }
    const listPath = path.join(workDir, 'list.txt');
    await fsp.writeFile(listPath, segments.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    onProgress?.(`Joining ${segments.length} clips`);
    await spawnImpl({ bin: 'ffmpeg', args: concatArgs({ listPath, outputPath }) });
    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat?.size) throw new CutVideoJoinError('ffmpeg produced no output', { status: 500 });
    return { durationSeconds: await probeDurationSeconds(outputPath), clipCount: segments.length, size: stat.size };
  } finally {
    await safeRm(workDir);
    for (const p of downloaded) await safeRm(p);
  }
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();

export function getCutVideoJoinJob(jobId) {
  return jobs.get(String(jobId || '')) || null;
}

export function serializeJoinJob(job) {
  if (!job) return null;
  const { path: _path, ...rest } = job;
  return rest;
}

export async function _resetCutVideoJoinJobsForTests() {
  for (const job of jobs.values()) await safeRm(job.path);
  jobs.clear();
}

function safeFilename(s) {
  return String(s || '').replace(/[^a-zA-Z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
}

// Validate, then join in the background. Cuts without a clip are left out
// and named in `missing`; a beat with no clip at all is a 400.
export async function startCutVideoJoinJob({ projectId, beatId, projectTitle = '' }) {
  const beat = await getBeat(projectId, String(beatId));
  if (!beat) throw new CutVideoJoinError('beat not found', { status: 404 });
  const [scenes, cuts] = await Promise.all([
    listVideoScenes({ projectId, beatId: beat._id }),
    listVideoPrompts({ projectId, beatId: beat._id }),
  ]);
  const ordered = orderedCutsWithLabels(scenes, cuts);
  const clips = ordered.filter(({ cut }) => cut.video_file_id).map(({ cut, label }) => ({ video_file_id: cut.video_file_id, label }));
  if (!clips.length) throw new CutVideoJoinError('No cut of this beat has a video yet');

  const jobId = new ObjectId().toString();
  const dir = path.join(os.tmpdir(), 'screenplay-cut-join-out');
  await fsp.mkdir(dir, { recursive: true });
  const name = [safeFilename(projectTitle), `beat-${beat.order}`, safeFilename(stripMarkdown(beat.name || ''))].filter(Boolean).join('-');
  const job = {
    job_id: jobId,
    beat_id: beat._id.toString(),
    status: 'running',
    step: 'Starting',
    clip_count: clips.length,
    missing: ordered.filter(({ cut }) => !cut.video_file_id).map(({ label }) => label),
    filename: `${name || 'videos'}.mp4`,
    duration_seconds: null,
    size: null,
    error: null,
    started_at: new Date(),
    finished_at: null,
    path: path.join(dir, `${jobId}.mp4`),
  };
  jobs.set(jobId, job);
  const t = setTimeout(() => {
    jobs.delete(jobId);
    safeRm(job.path);
  }, JOB_RETENTION_MS);
  t.unref?.();

  joinClips({ clips, outputPath: job.path, onProgress: (step) => { job.step = step; } })
    .then((r) => {
      job.duration_seconds = r.durationSeconds;
      job.size = r.size;
      job.status = 'done';
      job.step = 'Ready';
      logger.info(`cut video join ${jobId}: beat=${job.beat_id} clips=${r.clipCount} size=${r.size}`);
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e?.message || String(e);
      logger.error(`cut video join ${jobId} failed: ${job.error}`);
      return safeRm(job.path);
    })
    .finally(() => {
      job.finished_at = new Date();
    });
  return job;
}
