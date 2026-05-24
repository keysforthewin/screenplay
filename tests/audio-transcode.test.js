// Unit tests for the ffmpeg audio normalization module. The spawn is swapped
// out via __setAudioFfmpegImplForTests so the real tmp-file write/read plumbing
// runs, but no actual ffmpeg binary is needed.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import {
  convertToMp3,
  trimToSeconds,
  FfmpegMissingError,
  AudioTranscodeError,
  __setAudioFfmpegImplForTests,
} from '../src/web/audioTranscode.js';

afterEach(() => __setAudioFfmpegImplForTests(null));

describe('convertToMp3', () => {
  it('runs ffmpeg with libmp3lame and returns the output bytes', async () => {
    let seenArgs;
    __setAudioFfmpegImplForTests(async ({ args, outputPath }) => {
      seenArgs = args;
      fs.writeFileSync(outputPath, Buffer.from('ID3-fake-mp3'));
    });
    const out = await convertToMp3(Buffer.from('webm-bytes'));
    expect(out.toString()).toBe('ID3-fake-mp3');
    expect(seenArgs).toContain('libmp3lame');
    expect(seenArgs).toContain('-vn');
    expect(seenArgs).toContain('-b:a');
  });

  it('rejects an empty buffer without spawning ffmpeg', async () => {
    let called = false;
    __setAudioFfmpegImplForTests(async () => {
      called = true;
    });
    await expect(convertToMp3(Buffer.alloc(0))).rejects.toThrow(AudioTranscodeError);
    expect(called).toBe(false);
  });

  it('propagates FfmpegMissingError', async () => {
    __setAudioFfmpegImplForTests(async () => {
      throw new FfmpegMissingError();
    });
    await expect(convertToMp3(Buffer.from('x'))).rejects.toThrow(FfmpegMissingError);
  });

  it('reports AudioTranscodeError when ffmpeg produced no output', async () => {
    __setAudioFfmpegImplForTests(async () => {
      /* resolve without writing the output file */
    });
    await expect(convertToMp3(Buffer.from('x'))).rejects.toThrow(AudioTranscodeError);
  });
});

describe('trimToSeconds', () => {
  it('passes -t <seconds> and returns trimmed bytes', async () => {
    let seenArgs;
    __setAudioFfmpegImplForTests(async ({ args, outputPath }) => {
      seenArgs = args;
      fs.writeFileSync(outputPath, Buffer.from('trimmed'));
    });
    const out = await trimToSeconds(Buffer.from('long-audio'), 15);
    expect(out.toString()).toBe('trimmed');
    const tIdx = seenArgs.indexOf('-t');
    expect(tIdx).toBeGreaterThan(-1);
    expect(seenArgs[tIdx + 1]).toBe('15');
  });

  it('rejects a non-positive duration', async () => {
    await expect(trimToSeconds(Buffer.from('x'), 0)).rejects.toThrow(AudioTranscodeError);
    await expect(trimToSeconds(Buffer.from('x'), NaN)).rejects.toThrow(AudioTranscodeError);
  });
});
