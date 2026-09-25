// concatAudioToMp3 joins N recordings with gaps through one ffmpeg run.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { concatAudioToMp3, __setAudioFfmpegImplForTests, AudioTranscodeError } from '../src/web/audioTranscode.js';

afterEach(() => __setAudioFfmpegImplForTests(null));

function fakeFfmpeg(captured) {
  return async ({ args, inputPaths, inputPath, outputPath }) => {
    captured.push({ args, inputPaths, inputPath, outputPath });
    fs.writeFileSync(outputPath, Buffer.from('mp3-bytes'));
  };
}

describe('concatAudioToMp3', () => {
  it('writes every input to its own tmp file and builds one concat filter with gaps and a tail', async () => {
    const captured = [];
    __setAudioFfmpegImplForTests(fakeFfmpeg(captured));
    const out = await concatAudioToMp3([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')], { gapSeconds: 0.25, tailSeconds: 0.3 });
    expect(out.toString()).toBe('mp3-bytes');
    expect(captured).toHaveLength(1);
    const { args, inputPaths, inputPath } = captured[0];
    expect(inputPaths).toHaveLength(3);
    expect(inputPath).toBe(inputPaths[0]);
    expect(args.filter((a) => a === '-i')).toHaveLength(3);
    const filter = args[args.indexOf('-filter_complex') + 1];
    expect(filter).toContain('concat=n=3:v=0:a=1[out]');
    expect(filter).toContain('[0:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=pad_dur=0.250[a0]');
    expect(filter).toContain('[1:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=pad_dur=0.250[a1]');
    expect(filter).toContain('[2:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=pad_dur=0.300[a2]');
    expect(args).toContain('libmp3lame');
    expect(args[args.indexOf('-map') + 1]).toBe('[out]');
    // tmp inputs are cleaned up
    for (const p of inputPaths) expect(fs.existsSync(p)).toBe(false);
  });

  it('a single recording is just normalized (no padding)', async () => {
    const captured = [];
    __setAudioFfmpegImplForTests(fakeFfmpeg(captured));
    await concatAudioToMp3([Buffer.from('solo')]);
    expect(captured).toHaveLength(1);
    expect(captured[0].args).not.toContain('-filter_complex');
    expect(captured[0].inputPaths).toBeUndefined();
  });

  it('rejects empty input', async () => {
    await expect(concatAudioToMp3([])).rejects.toBeInstanceOf(AudioTranscodeError);
    await expect(concatAudioToMp3([Buffer.from('a'), Buffer.alloc(0)])).rejects.toBeInstanceOf(AudioTranscodeError);
  });
});
