// Prompts-tab assembly (src/web/cutAssemble.js): join cut clips into a scene
// MP4 and a beat MP4, persisted apart from the Storyboard tab's beat video;
// the gateway clears them when the cut set changes and frees the files when
// scenes or the beat are deleted. ffmpeg goes through the assembly spawn seam.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const broadcasts = [];
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn((room, payload) => broadcasts.push({ room, payload })),
  isHocuspocusRunning: () => false,
}));

const uploaded = [];
const deletedAttachments = [];
const streamed = [];
vi.mock('../src/mongo/attachments.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    streamAttachmentToTmp: vi.fn(async (id) => {
      const dir = path.join(os.tmpdir(), 'screenplay-cut-assemble-test');
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
    deleteAttachment: vi.fn(async (id) => {
      deletedAttachments.push(String(id));
    }),
    deleteAttachments: vi.fn(async (ids) => {
      for (const id of ids) deletedAttachments.push(String(id));
    }),
  };
});
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, deleteImages: vi.fn(async () => {}) };
});
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({ deleteEntity: async () => {}, deleteProjectChunks: async () => 0 }));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const VS = await import('../src/mongo/videoScenes.js');
const Gateway = await import('../src/web/gateway.js');
const Assemble = await import('../src/web/beatAssemble.js');
const CutAssemble = await import('../src/web/cutAssemble.js');
const BeatLocks = await import('../src/web/beatLocks.js');

const spawnCalls = [];
function fakeSpawn({ duration = '9.5' } = {}) {
  return async ({ bin, args }) => {
    spawnCalls.push({ bin, args });
    if (bin === 'ffprobe') {
      if (args.includes('stream=codec_type')) return { stdout: 'audio\n' };
      return { stdout: `${duration}\n` };
    }
    fs.writeFileSync(args[args.length - 1], Buffer.from(`out:${path.basename(args[args.length - 1])}`));
    return { stdout: '' };
  };
}

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  broadcasts.length = 0;
  uploaded.length = 0;
  deletedAttachments.length = 0;
  streamed.length = 0;
  spawnCalls.length = 0;
  BeatLocks._clearBeatLocksForTests();
  CutAssemble._clearCutAssembleJobsForTests();
  Assemble.__setAssembleSpawnImplForTests(fakeSpawn());
  projectId = (await createProject('Cut Assemble'))._id.toString();
});
afterEach(() => Assemble.__setAssembleSpawnImplForTests(null));

async function seed({ clips = 'all' } = {}) {
  const beat = await Plots.createBeat({ projectId, name: 'Diner', body: 'INT. DINER — NIGHT\n\nSarah waits.' });
  const s1 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'One' });
  const s2 = await VS.createVideoScene({ projectId, beatId: beat._id, title: 'Two' });
  const c1 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 1, order: 1, title: 'c1' });
  const c2 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s1._id, cutIndex: 2, order: 2, title: 'c2' });
  const c3 = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId: s2._id, cutIndex: 1, order: 3, title: 'c3' });
  const cuts = [c1, c2, c3];
  const withClip = clips === 'all' ? cuts : cuts.filter((c) => clips.includes(c.title));
  for (const c of withClip) {
    await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: String(c._id), videoFileId: new ObjectId(), durationSeconds: 4 });
  }
  return { beat, s1, s2, c1, c2, c3 };
}

async function waitJob(id) {
  for (let i = 0; i < 200; i++) {
    const j = CutAssemble.getCutAssembleJob(id);
    if (j && (j.status === 'done' || j.status === 'error')) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not finish');
}

describe('assembleSceneVideo', () => {
  it('joins the scene cuts in cut_index order and points the scene at the MP4', async () => {
    const { beat, s1, c1, c2 } = await seed();
    const cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id, sceneId: s1._id });
    // Hand them over out of order: the assembler sorts by cut_index.
    const r = await CutAssemble.assembleSceneVideo({ projectId, scene: s1, cuts: [...cuts].reverse() });
    const ffmpegs = spawnCalls.filter((c) => c.bin === 'ffmpeg');
    expect(ffmpegs).toHaveLength(3); // 2 normalizes + 1 concat
    const fresh = await VP.listVideoPrompts({ projectId, beatId: beat._id, sceneId: s1._id });
    const byTitle = Object.fromEntries(fresh.map((c) => [c.title, c]));
    expect(ffmpegs[0].args[1]).toContain(String(byTitle.c1.video_file_id));
    expect(ffmpegs[1].args[1]).toContain(String(byTitle.c2.video_file_id));
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].generatedBy).toBe('scene-assemble');
    expect(uploaded[0].ownerType).toBe('beat');
    expect(String(uploaded[0].ownerId)).toBe(String(beat._id));
    expect(uploaded[0].filename).toMatch(new RegExp(`^scene-${s1._id}-video-`));
    expect(r.durationSeconds).toBe(9.5);
    const scene = await VS.getVideoScene(projectId, s1._id);
    expect(scene.video_file_id).toBe(String(uploaded[0]._id));
    expect(scene.video_duration_seconds).toBe(9.5);
    expect(scene.video_generated_at).toBeInstanceOf(Date);
    const ping = broadcasts.find((b) => b.payload?.changed?.includes('scene_video'));
    expect(ping.room).toBe(`video_prompts:${beat._id}`);
    expect(ping.payload.video_scene_id).toBe(String(s1._id));
    for (const p of streamed) expect(fs.existsSync(p)).toBe(false);
    void c1;
    void c2;
  });

  it("trims each clip to its cut: the middle of a travelling move, the end of a held cut, a dialogue cut whole", async () => {
    const { beat, s1, c1, c2 } = await seed();
    // The fake ffprobe reports every clip as 9.5 s long.
    await VP.updateVideoPrompt(projectId, c1._id, { camera: { movement: 'pan' }, duration_seconds: 6 });
    await VP.updateVideoPrompt(projectId, c2._id, { duration_seconds: 1.5 });
    let cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id, sceneId: s1._id });
    await CutAssemble.assembleSceneVideo({ projectId, scene: s1, cuts });
    const window = (args) => (args.includes('-t') ? [args.includes('-ss') ? args[args.indexOf('-ss') + 1] : null, args[args.indexOf('-t') + 1]] : null);
    let ffmpegs = spawnCalls.filter((c) => c.bin === 'ffmpeg');
    expect(window(ffmpegs[0].args)).toEqual(['1.750', '6.000']);
    expect(window(ffmpegs[1].args)).toEqual(['8.000', '1.500']);

    // Hand-set trims win; a cut that covers dialogue is never trimmed automatically.
    spawnCalls.length = 0;
    await VP.updateVideoPrompt(projectId, c1._id, { trim_head_seconds: 1, trim_tail_seconds: 0.5 });
    await VP.updateVideoPrompt(projectId, c2._id, { dialog_ids: [new ObjectId()] });
    cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id, sceneId: s1._id });
    await CutAssemble.assembleSceneVideo({ projectId, scene: s1, cuts });
    ffmpegs = spawnCalls.filter((c) => c.bin === 'ffmpeg');
    expect(window(ffmpegs[0].args)).toEqual(['1.000', '8.000']);
    expect(window(ffmpegs[1].args)).toBe(null);
  });

  it('refuses when a cut has no clip and names it by scene.cut', async () => {
    const { beat, s1 } = await seed({ clips: ['c1', 'c3'] });
    const cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id, sceneId: s1._id });
    await expect(CutAssemble.assembleSceneVideo({ projectId, scene: s1, cuts })).rejects.toMatchObject({
      code: 'CUT_ASSEMBLE_INPUT',
      status: 400,
      missing: ['1.2'],
    });
    expect(spawnCalls).toHaveLength(0);
    expect(uploaded).toHaveLength(0);
  });
});

describe('assemblePromptsBeatVideo', () => {
  it('writes prompts_video_* and never touches the Storyboard tab video_*; re-assembling replaces the file', async () => {
    const { beat, s1, s2 } = await seed();
    const cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    const first = await CutAssemble.assemblePromptsBeatVideo({ projectId, beat, cuts, scenes: [s1, s2] });
    expect(uploaded[0].generatedBy).toBe('prompts-beat-assemble');
    expect(uploaded[0].filename).toMatch(new RegExp(`^beat-${beat._id}-prompts-video-`));
    let b = await Plots.getBeat(projectId, String(beat._id));
    expect(b.prompts_video_file_id).toBe(String(first.file._id));
    expect(b.prompts_video_duration_seconds).toBe(9.5);
    expect(b.prompts_video_generated_at).toBeInstanceOf(Date);
    expect(b.video_file_id ?? null).toBeNull();
    const ping = broadcasts.find((b2) => b2.payload?.changed?.includes('beat_video'));
    expect(ping.room).toBe(`video_prompts:${beat._id}`);
    // Beat-wide order: three clips normalized, one concat.
    expect(spawnCalls.filter((c) => c.bin === 'ffmpeg')).toHaveLength(4);

    const second = await CutAssemble.assemblePromptsBeatVideo({ projectId, beat, cuts, scenes: [s1, s2] });
    b = await Plots.getBeat(projectId, String(beat._id));
    expect(b.prompts_video_file_id).toBe(String(second.file._id));
    expect(deletedAttachments).toContain(String(first.file._id));
  });

  it('names missing cuts by scene.cut across the beat', async () => {
    const { beat, s1, s2 } = await seed({ clips: ['c1'] });
    const cuts = await VP.listVideoPrompts({ projectId, beatId: beat._id });
    await expect(CutAssemble.assemblePromptsBeatVideo({ projectId, beat, cuts, scenes: [s1, s2] })).rejects.toMatchObject({
      missing: ['1.2', '2.1'],
    });
  });
});

describe('startCutAssembleJob', () => {
  it('runs the beat assembly in the background and reports the file', async () => {
    const { beat } = await seed();
    const jobId = await CutAssemble.startCutAssembleJob({ projectId, beatId: String(beat._id) });
    const job = await waitJob(jobId);
    expect(job.status).toBe('done');
    expect(job.kind).toBe('assemble');
    expect(job.scene_id).toBeNull();
    expect(job.video_file_id).toBe(String(uploaded[0]._id));
    expect(job.video_duration_seconds).toBe(9.5);
    const b = await Plots.getBeat(projectId, String(beat._id));
    expect(b.prompts_video_file_id).toBe(job.video_file_id);
  });

  it('assembles one scene when sceneId is given', async () => {
    const { beat, s2 } = await seed();
    const jobId = await CutAssemble.startCutAssembleJob({ projectId, beatId: String(beat._id), sceneId: String(s2._id) });
    const job = await waitJob(jobId);
    expect(job.status).toBe('done');
    expect(job.scene_id).toBe(String(s2._id));
    const scene = await VS.getVideoScene(projectId, s2._id);
    expect(scene.video_file_id).toBe(job.video_file_id);
    const b = await Plots.getBeat(projectId, String(beat._id));
    expect(b.prompts_video_file_id ?? null).toBeNull();
  });

  it('rejects synchronously: missing clips (400), unknown scene (404), locked beat (409)', async () => {
    const { beat, s1 } = await seed({ clips: ['c1', 'c3'] });
    await expect(CutAssemble.startCutAssembleJob({ projectId, beatId: String(beat._id) })).rejects.toMatchObject({ code: 'CUT_ASSEMBLE_INPUT', missing: ['1.2'] });
    await expect(CutAssemble.startCutAssembleJob({ projectId, beatId: String(beat._id), sceneId: new ObjectId().toString() })).rejects.toMatchObject({ code: 'SCENE_NOT_FOUND' });
    let release;
    BeatLocks.withBeatLock(beat._id, () => new Promise((r) => { release = r; }));
    await expect(CutAssemble.startCutAssembleJob({ projectId, beatId: String(beat._id), sceneId: String(s1._id) })).rejects.toMatchObject({ code: 'BEAT_BUSY' });
    release();
  });

  it('surfaces an ffmpeg failure on the job', async () => {
    const { beat } = await seed();
    Assemble.__setAssembleSpawnImplForTests(async () => {
      throw new Assemble.BeatAssembleError('boom');
    });
    const jobId = await CutAssemble.startCutAssembleJob({ projectId, beatId: String(beat._id) });
    const job = await waitJob(jobId);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/boom/);
  });
});

describe('gateway invalidation and cascades', () => {
  async function assembled() {
    const s = await seed();
    const cuts = await VP.listVideoPrompts({ projectId, beatId: s.beat._id });
    const scene1 = await CutAssemble.assembleSceneVideo({ projectId, scene: s.s1, cuts: cuts.filter((c) => String(c.scene_id) === String(s.s1._id)) });
    const scene2 = await CutAssemble.assembleSceneVideo({ projectId, scene: s.s2, cuts: cuts.filter((c) => String(c.scene_id) === String(s.s2._id)) });
    const beatVid = await CutAssemble.assemblePromptsBeatVideo({ projectId, beat: s.beat, cuts, scenes: [s.s1, s.s2] });
    deletedAttachments.length = 0;
    return { ...s, sceneFile1: String(scene1.file._id), sceneFile2: String(scene2.file._id), beatFile: String(beatVid.file._id) };
  }

  it('deleting a cut clears its scene MP4 and the beat MP4, keeps the other scene', async () => {
    const { beat, s1, s2, c2, sceneFile1, sceneFile2, beatFile } = await assembled();
    await Gateway.deleteVideoPromptViaGateway({ projectId, promptId: String(c2._id) });
    expect(deletedAttachments).toEqual(expect.arrayContaining([sceneFile1, beatFile]));
    expect(deletedAttachments).not.toContain(sceneFile2);
    expect((await VS.getVideoScene(projectId, s1._id)).video_file_id).toBeNull();
    expect((await VS.getVideoScene(projectId, s2._id)).video_file_id).toBe(sceneFile2);
    expect((await Plots.getBeat(projectId, String(beat._id))).prompts_video_file_id).toBeNull();
  });

  it('a single cut re-render keeps the assembled MP4s', async () => {
    const { beat, s1, c1, sceneFile1, beatFile } = await assembled();
    await Gateway.setVideoPromptVideoViaGateway({ projectId, promptId: String(c1._id), videoFileId: new ObjectId(), durationSeconds: 3 });
    expect((await VS.getVideoScene(projectId, s1._id)).video_file_id).toBe(sceneFile1);
    expect((await Plots.getBeat(projectId, String(beat._id))).prompts_video_file_id).toBe(beatFile);
  });

  it('reordering scenes clears only the beat MP4; reordering cuts in a scene clears that scene and the beat', async () => {
    const { beat, s1, s2, c1, c2, sceneFile1, sceneFile2, beatFile } = await assembled();
    await Gateway.reorderVideoScenesViaGateway({ projectId, beatId: String(beat._id), orderedIds: [String(s2._id), String(s1._id)] });
    expect(deletedAttachments).toEqual([beatFile]);
    expect((await VS.getVideoScene(projectId, s1._id)).video_file_id).toBe(sceneFile1);
    deletedAttachments.length = 0;
    await Gateway.reorderCutsInSceneViaGateway({ projectId, sceneId: String(s1._id), orderedIds: [String(c2._id), String(c1._id)] });
    expect(deletedAttachments).toEqual([sceneFile1]);
    expect((await VS.getVideoScene(projectId, s2._id)).video_file_id).toBe(sceneFile2);
  });

  it('deleting a scene frees its MP4 and clears the beat MP4; wiping frees every scene MP4', async () => {
    const { beat, s1, s2, sceneFile1, sceneFile2, beatFile } = await assembled();
    await Gateway.deleteVideoSceneViaGateway({ projectId, sceneId: String(s1._id) });
    expect(deletedAttachments).toEqual(expect.arrayContaining([sceneFile1, beatFile]));
    expect(deletedAttachments).not.toContain(sceneFile2);
    deletedAttachments.length = 0;
    await Gateway.deleteAllVideoPromptsForBeatViaGateway({ projectId, beatId: String(beat._id) });
    expect(deletedAttachments).toContain(sceneFile2);
    expect(await VS.getVideoScene(projectId, s2._id)).toBeNull();
  });

  it('deleting the beat frees the Prompts-tab MP4 and the scene MP4s', async () => {
    const { beat, sceneFile1, sceneFile2, beatFile } = await assembled();
    await Gateway.deleteBeatViaGateway(projectId, String(beat._id));
    expect(deletedAttachments).toEqual(expect.arrayContaining([sceneFile1, sceneFile2, beatFile]));
  });
});
