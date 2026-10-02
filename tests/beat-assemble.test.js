// assembleClips: normalize each clip (silent ones get a generated track),
// concat by demuxer, upload, clean tmp. (Persisting the pointer is the
// caller's job — see tests/cut-assemble.test.js.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ObjectId } from 'mongodb';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const uploaded = [];
const streamed = [];
vi.mock('../src/mongo/attachments.js', () => ({
  streamAttachmentToTmp: vi.fn(async (id) => {
    const dir = path.join(os.tmpdir(), 'screenplay-attachments-test');
    await fsp.mkdir(dir, { recursive: true });
    const p = path.join(dir, `${String(id)}.mp4`);
    await fsp.writeFile(p, Buffer.from(`clip-${String(id)}`));
    streamed.push(p);
    return { path: p, file: { _id: id } };
  }),
  uploadAttachmentBuffer: vi.fn(async (_pid, args) => {
    const file = { _id: new ObjectId(), ...args };
    uploaded.push(file);
    return file;
  }),
}));

const Assemble = await import('../src/web/beatAssemble.js');

const assemble = ({ projectId, beat, shots }) =>
  Assemble.assembleClips({
    projectId,
    clips: shots,
    ownerId: beat._id,
    filename: `beat-${beat._id}-video.mp4`,
    generatedBy: 'beat-assemble',
    label: 'shot',
  });

const calls = [];
function fakeSpawn({ silentIds = [], duration = '12.5' } = {}) {
  return async ({ bin, args }) => {
    calls.push({ bin, args });
    if (bin === 'ffprobe') {
      if (args.includes('stream=codec_type')) {
        const input = args[args.length - 1];
        const silent = silentIds.some((id) => input.includes(String(id)));
        return { stdout: silent ? '' : 'audio\n' };
      }
      return { stdout: `${duration}\n` };
    }
    const outputPath = args[args.length - 1];
    fs.writeFileSync(outputPath, Buffer.from(`out:${path.basename(outputPath)}`));
    return { stdout: '' };
  };
}

const beat = { _id: new ObjectId(), order: 1, name: 'Diner' };
const shot = (order, extra = {}) => ({ _id: new ObjectId(), order, video_file_id: new ObjectId(), video_duration_seconds: 5, ...extra });

beforeEach(() => {
  calls.length = 0;
  uploaded.length = 0;
  streamed.length = 0;
});
afterEach(() => Assemble.__setAssembleSpawnImplForTests(null));

describe('normalizeArgs / concatArgs', () => {
  it('scales into 1920x1080 with padding at 24fps and maps the clip audio', () => {
    const args = Assemble.normalizeArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', hasAudio: true });
    const vf = args[args.indexOf('-vf') + 1];
    expect(vf).toContain('scale=1920:1080:force_original_aspect_ratio=decrease');
    expect(vf).toContain('pad=1920:1080');
    expect(vf).toContain('fps=24');
    expect(vf).toContain('format=yuv420p');
    expect(args).not.toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('0:a:0');
    expect(args).not.toContain('-shortest');
    expect(args).toContain('libx264');
  });
  it('a silent clip gets a generated silent track trimmed to the video', () => {
    const args = Assemble.normalizeArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', hasAudio: false });
    expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(args[args.indexOf('-map', args.indexOf('-map') + 1) + 1]).toBe('1:a:0');
    expect(args).toContain('-shortest');
  });
  it('trims to a window with output-side -ss/-t, after the stream maps', () => {
    const vf =
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p';
    const encode = ['-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k'];
    expect(Assemble.normalizeArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', hasAudio: false, trim: { start: 0.5, duration: 6 } })).toEqual([
      '-i', 'in.mp4', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-map', '0:v:0', '-map', '1:a:0', '-ss', '0.500', '-t', '6.000',
      ...encode, '-shortest', '-movflags', '+faststart', '-y', 'out.mp4',
    ]);
    expect(Assemble.normalizeArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', hasAudio: true, trim: { start: 0.5, duration: 6 } })).toEqual([
      '-i', 'in.mp4', '-map', '0:v:0', '-map', '0:a:0', '-ss', '0.500', '-t', '6.000',
      ...encode, '-movflags', '+faststart', '-y', 'out.mp4',
    ]);
    // A window that starts at 0 needs no seek.
    const head = Assemble.normalizeArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4', hasAudio: true, trim: { start: 0, duration: 1.5 } });
    expect(head).not.toContain('-ss');
    expect(head.slice(head.indexOf('-t'), head.indexOf('-t') + 2)).toEqual(['-t', '1.500']);
  });
  it('concat uses the demuxer with stream copy', () => {
    const args = Assemble.concatArgs({ listPath: 'list.txt', outputPath: 'beat.mp4' });
    expect(args.slice(0, 6)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'list.txt']);
    expect(args).toContain('copy');
  });
});

describe('assembleClips', () => {
  it('normalizes every clip in order, joins them and uploads the result', async () => {
    const shots = [shot(2), shot(0, { video_duration_seconds: 7 }), shot(1)];
    Assemble.__setAssembleSpawnImplForTests(fakeSpawn({ silentIds: [shots[2].video_file_id] }));
    const { file, durationSeconds } = await assemble({ projectId: 'p', beat, shots });

    // 3 audio probes + 3 normalizes + 1 concat + 1 duration probe
    const ffmpegs = calls.filter((c) => c.bin === 'ffmpeg');
    expect(ffmpegs).toHaveLength(4);
    // Order 0,1,2 — the shot with order 0 (index 1) is normalized first.
    expect(ffmpegs[0].args[1]).toContain(String(shots[1].video_file_id));
    expect(ffmpegs[1].args[1]).toContain(String(shots[2].video_file_id));
    // The silent clip (order 1) got anullsrc.
    expect(ffmpegs[1].args).toContain('-shortest');
    expect(ffmpegs[0].args).not.toContain('-shortest');
    // Concat list references the segments in order.
    const concat = ffmpegs[3];
    expect(concat.args).toContain('concat');
    expect(durationSeconds).toBe(12.5);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].contentType).toBe('video/mp4');
    expect(uploaded[0].ownerType).toBe('beat');
    expect(uploaded[0].generatedBy).toBe('beat-assemble');
    expect(file._id).toBe(uploaded[0]._id);
    // tmp cleanup: downloaded clips are gone
    for (const p of streamed) expect(fs.existsSync(p)).toBe(false);
  });

  it('falls back to the summed clip lengths when the duration probe fails', async () => {
    const shots = [shot(0, { video_duration_seconds: 4 }), shot(1, { video_duration_seconds: 6 })];
    Assemble.__setAssembleSpawnImplForTests(async ({ bin, args }) => {
      if (bin === 'ffprobe' && args.includes('format=duration')) throw new Error('boom');
      if (bin === 'ffprobe') return { stdout: 'audio' };
      fs.writeFileSync(args[args.length - 1], Buffer.from('x'));
      return { stdout: '' };
    });
    const { durationSeconds } = await assemble({ projectId: 'p', beat, shots });
    expect(durationSeconds).toBe(10);
  });

  it('probes each clip that carries a trim policy and keeps only the resolved window', async () => {
    const shots = [
      shot(0, { trim: { want_seconds: 6, anchor: 'centre' } }), // 7 s clip → the middle 6
      shot(1, { trim: { want_seconds: 1.5, anchor: 'tail' } }), // 7 s clip → the last 1.5
      shot(2, { trim: { want_seconds: 9, anchor: 'tail' } }), // shorter than the cut: whole
      shot(3),
    ];
    Assemble.__setAssembleSpawnImplForTests(fakeSpawn({ duration: '7.0' }));
    await assemble({ projectId: 'p', beat, shots });
    const normalizes = calls.filter((c) => c.bin === 'ffmpeg').slice(0, 4).map((c) => c.args);
    const window = (args) => (args.includes('-t') ? [args.includes('-ss') ? args[args.indexOf('-ss') + 1] : null, args[args.indexOf('-t') + 1]] : null);
    expect(normalizes.map(window)).toEqual([['0.500', '6.000'], ['5.500', '1.500'], null, null]);
    // One duration probe per clip with a policy, plus the output's.
    expect(calls.filter((c) => c.bin === 'ffprobe' && c.args.includes('format=duration'))).toHaveLength(4);
  });

  it('leaves a clip whole when its length cannot be probed, and sums the kept lengths', async () => {
    const shots = [
      shot(0, { video_duration_seconds: 7, trim: { want_seconds: 6, anchor: 'centre' } }),
      shot(1, { video_duration_seconds: 4 }),
    ];
    Assemble.__setAssembleSpawnImplForTests(async ({ bin, args }) => {
      calls.push({ bin, args });
      if (bin === 'ffprobe' && args.includes('format=duration')) throw new Error('boom');
      if (bin === 'ffprobe') return { stdout: 'audio' };
      fs.writeFileSync(args[args.length - 1], Buffer.from('x'));
      return { stdout: '' };
    });
    const { durationSeconds } = await assemble({ projectId: 'p', beat, shots });
    expect(calls.filter((c) => c.bin === 'ffmpeg')[0].args).not.toContain('-t');
    expect(durationSeconds).toBe(11);
  });

  it('refuses when a shot has no clip', async () => {
    Assemble.__setAssembleSpawnImplForTests(fakeSpawn());
    await expect(
      assemble({ projectId: 'p', beat, shots: [shot(0), shot(1, { video_file_id: null })] }),
    ).rejects.toThrow(/without a rendered clip \(shot 2\)/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a missing binary as FfmpegMissingError and still cleans up', async () => {
    const shots = [shot(0)];
    Assemble.__setAssembleSpawnImplForTests(async ({ bin }) => {
      throw new Assemble.FfmpegMissingError(bin);
    });
    await expect(assemble({ projectId: 'p', beat, shots })).rejects.toBeInstanceOf(Assemble.FfmpegMissingError);
    expect(uploaded).toHaveLength(0);
    for (const p of streamed) expect(fs.existsSync(p)).toBe(false);
  });
});
