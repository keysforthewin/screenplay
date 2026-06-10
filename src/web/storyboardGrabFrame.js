// Extracts the last frame of a previous storyboard's generated MP4 and adds it
// as a new frame in the current storyboard's frame pool. Used by the "Grab from
// previous" button on the storyboard page to support seamless joining between
// shots for video models that accept a start frame (Kling 3 Pro, Veo 3.1, etc.).

import { spawn } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '../log.js';
import { streamAttachmentToTmp } from '../mongo/attachments.js';
import { uploadGeneratedImage } from '../mongo/images.js';
import { validateImageBuffer } from '../mongo/imageBytes.js';
import { addStoryboardFrameViaGateway } from './gateway.js';

export class FfmpegMissingError extends Error {
  constructor() {
    super('ffmpeg is not installed on the server (binary not found on PATH).');
    this.name = 'FfmpegMissingError';
  }
}

export class FfmpegFailedError extends Error {
  constructor(message) {
    super(`ffmpeg failed extracting last frame: ${message}`);
    this.name = 'FfmpegFailedError';
  }
}

// Internal seam: swapped out by tests. Production runs ffmpeg via spawn.
// Resolves with the output JPEG buffer on success, rejects on failure.
let extractLastFrameImpl = defaultExtractLastFrame;

export function __setExtractLastFrameImplForTests(fn) {
  extractLastFrameImpl = fn || defaultExtractLastFrame;
}

function defaultExtractLastFrame({ inputPath, outputPath }) {
  return new Promise((resolve, reject) => {
    // -sseof -1   : seek to 1 second before end of file (ffmpeg clamps to 0
    //               for clips shorter than 1s — we still get the last decoded
    //               frame either way).
    // -update 1   : write a single image; required for image2 muxer w/ one file.
    // -frames:v 1 : stop after one video frame.
    // -q:v 2      : JPEG quality (2 is near-lossless, file ~80–200KB).
    // -y          : overwrite output without prompting.
    const args = [
      '-sseof', '-1',
      '-i', inputPath,
      '-update', '1',
      '-frames:v', '1',
      '-q:v', '2',
      '-y',
      outputPath,
    ];
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      reject(new FfmpegFailedError(e?.message || String(e)));
      return;
    }
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      // Cap stderr capture so a flood doesn't blow memory.
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    proc.on('error', (e) => {
      if (e?.code === 'ENOENT') {
        reject(new FfmpegMissingError());
      } else {
        reject(new FfmpegFailedError(e?.message || String(e)));
      }
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new FfmpegFailedError(stderr.trim().slice(-300) || `exit code ${code}`));
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

// Main entry. Inputs are pre-validated by the route (prev exists, has video).
//   currentSbId : ObjectId/hex of the storyboard receiving the start frame
//   prev        : full prev storyboard doc; we read prev.video_file_id and
//                 prev.beat_id (== currentSb.beat_id) for ownership metadata.
export async function grabFrameFromPrevious({ projectId, currentSbId, prev }) {
  if (!currentSbId) throw new Error('currentSbId required');
  if (!prev || !prev.video_file_id) {
    throw new Error('prev storyboard with video_file_id required');
  }
  if (!prev.beat_id) throw new Error('prev.beat_id required');

  const stamp = Date.now();
  const outDir = path.join(os.tmpdir(), 'screenplay-grab-frame');
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `grab-${currentSbId}-${stamp}.jpg`);

  let tmpVideoPath = null;
  try {
    const { path: videoPath } = await streamAttachmentToTmp(prev.video_file_id);
    tmpVideoPath = videoPath;

    await extractLastFrameImpl({ inputPath: tmpVideoPath, outputPath: outPath });

    let buffer;
    try {
      buffer = await fsp.readFile(outPath);
    } catch (e) {
      throw new FfmpegFailedError(
        `output file missing after ffmpeg exit 0: ${e?.message || e}`,
      );
    }
    if (!buffer.length) {
      throw new FfmpegFailedError('output file is empty');
    }

    // Sniff the file we just wrote — ffmpeg should always emit valid JPEG with
    // these args, but validateImageBuffer is the same gate every other image
    // entry point uses, so we stay consistent.
    validateImageBuffer(buffer);

    const file = await uploadGeneratedImage(projectId, {
      buffer,
      contentType: 'image/jpeg',
      ownerType: 'beat',
      ownerId: prev.beat_id,
      filename: `storyboard-${currentSbId}-frame-grab-${stamp}.jpg`,
      generatedBy: 'video-frame-grab',
    });

    const { storyboard, frameId } = await addStoryboardFrameViaGateway({
      projectId,
      storyboardId: currentSbId,
      imageId: file._id,
    });

    logger.info(
      `storyboard grab-frame: sb=${currentSbId} prev_video=${prev.video_file_id} -> image=${file._id} frame=${frameId}`,
    );

    return {
      storyboard,
      frame_id: frameId.toString(),
      image: { _id: file._id, content_type: 'image/jpeg' },
    };
  } finally {
    await safeUnlink(tmpVideoPath);
    await safeUnlink(outPath);
  }
}
