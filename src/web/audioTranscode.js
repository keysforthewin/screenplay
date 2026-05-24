// Server-side audio normalization via ffmpeg. Browser mic recordings arrive
// as audio/webm;codecs=opus (or audio/mp4); some fal models — notably
// bytedance/seedance-2.0/reference-to-video — only accept MP3, and that model
// additionally caps audio at 15s. This module reuses the same spawn-ffmpeg
// pattern as storyboardGrabFrame.js (tmp-file in/out, a swappable impl seam
// for tests, typed errors).
//
//   convertToMp3(buffer)            -> Buffer  (normalize any audio to MP3)
//   trimToSeconds(buffer, seconds)  -> Buffer  (cap MP3 duration; re-encodes)
//
// Both throw FfmpegMissingError when the binary isn't on PATH and
// AudioTranscodeError when ffmpeg exits non-zero. Callers decide how loud to
// be about that (the upload routes fail the request).

import { spawn } from 'child_process';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

export class FfmpegMissingError extends Error {
  constructor() {
    super('ffmpeg is not installed on the server (binary not found on PATH).');
    this.name = 'FfmpegMissingError';
    this.code = 'FFMPEG_MISSING';
  }
}

export class AudioTranscodeError extends Error {
  constructor(message) {
    super(`ffmpeg audio transcode failed: ${message}`);
    this.name = 'AudioTranscodeError';
    this.code = 'AUDIO_TRANSCODE_FAILED';
  }
}

// Internal seam: swapped out by tests. Production runs ffmpeg via spawn with
// the given args (which already contain the input/output paths). Resolves on
// exit 0, rejects with FfmpegMissingError / AudioTranscodeError otherwise.
let runImpl = defaultRunFfmpeg;

export function __setAudioFfmpegImplForTests(fn) {
  runImpl = fn || defaultRunFfmpeg;
}

function defaultRunFfmpeg({ args }) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      reject(new AudioTranscodeError(e?.message || String(e)));
      return;
    }
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      // Cap stderr capture so a flood doesn't blow memory.
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    proc.on('error', (e) => {
      if (e?.code === 'ENOENT') reject(new FfmpegMissingError());
      else reject(new AudioTranscodeError(e?.message || String(e)));
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AudioTranscodeError(stderr.trim().slice(-300) || `exit code ${code}`));
    });
  });
}

async function safeUnlink(p) {
  if (!p) return;
  try {
    await fsp.unlink(p);
  } catch {
    // best-effort cleanup; nothing to do if the temp file is already gone.
  }
}

// Run ffmpeg over an input buffer, returning the output file's bytes. The
// caller supplies a function that, given the resolved input/output paths,
// returns the full ffmpeg argument list.
async function runAudioFfmpeg(buffer, buildArgs) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AudioTranscodeError('empty input buffer');
  }
  const dir = path.join(os.tmpdir(), 'screenplay-audio-transcode');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(dir, `in-${stamp}`);
  const outputPath = path.join(dir, `out-${stamp}.mp3`);
  try {
    await fsp.writeFile(inputPath, buffer);
    const args = buildArgs({ inputPath, outputPath });
    await runImpl({ args, inputPath, outputPath });
    let out;
    try {
      out = await fsp.readFile(outputPath);
    } catch (e) {
      throw new AudioTranscodeError(
        `output file missing after ffmpeg exit 0: ${e?.message || e}`,
      );
    }
    if (!out.length) throw new AudioTranscodeError('output file is empty');
    return out;
  } finally {
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);
  }
}

// Normalize arbitrary audio bytes to a 192 kbps MP3 (inside seedance's
// 128–320 kbps window; a 15s clip is ~360 KB).
export async function convertToMp3(buffer) {
  return runAudioFfmpeg(buffer, ({ inputPath, outputPath }) => [
    '-i', inputPath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-y', outputPath,
  ]);
}

// Trim audio to at most `seconds`, re-encoding to MP3. ffmpeg's -t is a no-op
// when the source is shorter, so callers may invoke this unconditionally — but
// the orchestrator only does so when it knows (or can't rule out) the clip is
// over the model's cap, to avoid a needless re-encode.
export async function trimToSeconds(buffer, seconds) {
  const t = Number(seconds);
  if (!Number.isFinite(t) || t <= 0) {
    throw new AudioTranscodeError(`invalid trim seconds: ${seconds}`);
  }
  return runAudioFfmpeg(buffer, ({ inputPath, outputPath }) => [
    '-i', inputPath,
    '-t', String(t),
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-y', outputPath,
  ]);
}
