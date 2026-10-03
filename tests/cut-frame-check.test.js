// The quality loop for a cut's two stills (src/web/cutFrameCheck.js): the
// vision check through its seam, the repair loop in both directions, the
// derived end frame re-derived after a start fix, the two-round cap, the undo
// slot, cancel, and the jobs that run it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null, withDirectDocument: vi.fn(), broadcastRoomStateless: vi.fn(), isHocuspocusRunning: () => false,
}));

const store = new Map();
const deleted = [];
vi.mock('../src/mongo/images.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    readImageBuffer: vi.fn(async (id) => {
      const e = store.get(String(id));
      if (!e) return null;
      return { buffer: e.buffer, file: { _id: new ObjectId(String(id)), contentType: 'image/png', metadata: { description: '' } } };
    }),
    findImageFile: vi.fn(async (id) => {
      const e = store.get(String(id));
      if (!e) return null;
      return { _id: new ObjectId(String(id)), filename: 'x.png', contentType: 'image/png', length: e.buffer.length, metadata: { description: '' } };
    }),
    uploadGeneratedImage: vi.fn(async (_pid, args) => {
      const id = new ObjectId();
      store.set(id.toString(), { buffer: args.buffer });
      return { _id: id, filename: args.filename };
    }),
    deleteImages: vi.fn(async (ids) => { for (const id of ids) deleted.push(String(id)); }),
    deleteImage: vi.fn(async (id) => { deleted.push(String(id)); }),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const VP = await import('../src/mongo/videoPrompts.js');
const BeatLocks = await import('../src/web/beatLocks.js');
const SF = await import('../src/web/cutStartFrames.js');
const FC = await import('../src/web/cutFrameCheck.js');
const Gateway = await import('../src/web/gateway.js');

let projectId;
let dispatched;
let checks;
beforeEach(async () => {
  fakeDb.reset();
  store.clear();
  deleted.length = 0;
  dispatched = [];
  checks = [];
  BeatLocks._clearBeatLocksForTests();
  SF._clearCutStartFrameJobsForTests();
  SF._setStartFrameDispatcherForTests(async (args) => {
    dispatched.push(args);
    return { buffer: Buffer.from(`render-${dispatched.length}`), contentType: 'image/png', model: args.model };
  });
  projectId = (await createProject('Pairs'))._id.toString();
});
afterEach(() => {
  FC._setFrameCheckerForTests(null);
});

function img(text) {
  const id = new ObjectId();
  store.set(id.toString(), { buffer: Buffer.from(text) });
  return id;
}
const bytes = (id) => store.get(String(id)).buffer.toString();

// The checker answers from a queue of verdicts; the last one repeats.
function verdicts(...list) {
  FC._setFrameCheckerForTests(async ({ cut, text }) => {
    checks.push({ start: String(cut.start_frame.image_id), end: String(cut.end_frame.image_id), text });
    const v = list[Math.min(checks.length - 1, list.length - 1)];
    if (v instanceof Error) throw v;
    return { issues: v };
  });
}

const WARDROBE = { kind: 'wardrobe', frame_to_fix: 'end', note: 'The boy wears a grey T-shirt in the end frame and a red windbreaker in the start frame.', fix_instruction: 'Change the boy\'s grey T-shirt to the red zip windbreaker he wears in the other frame.' };
const DISPENSER = { kind: 'prop_added', frame_to_fix: 'start', note: 'A butter dispenser stands on the counter only in the end frame.', fix_instruction: 'Add a steel butter dispenser at the left end of the counter, exactly as in the other frame.' };

async function seedCut({ derive = false, movement = 'static' } = {}) {
  const beat = await Plots.createBeat({ projectId, name: 'Lobby', body: 'The boy buys popcorn.' });
  const startImg = img('start-original');
  const endImg = img('end-original');
  const cut = await VP.createVideoPrompt({
    projectId, beatId: beat._id, title: 'Counter',
    camera: { size: 'medium', movement },
    action: 'The clerk slides the bucket across the counter.', lastFrame: 'The bucket rests in front of the boy.',
    prompt: 'Medium shot at the counter: the clerk slides the bucket across to the boy.',
    startFrame: { prompt: 'The boy in the red windbreaker at the counter.', image_id: startImg, model: 'nano-banana-pro' },
    endFrame: { prompt: 'Same frame. The bucket rests in front of the boy.', image_id: endImg, model: 'flux-2-pro', derive },
  });
  return { beat, cut, startImg, endImg };
}

async function waitJob(id) {
  for (let i = 0; i < 500; i++) {
    const j = SF.getCutStartFrameJob(id);
    if (j && ['done', 'partial', 'error'].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
}

describe('checkCutFramePair', () => {
  it('needs both frames; an empty issue list passes; issues are normalized; an error is "unchecked"', async () => {
    const { cut } = await seedCut();
    expect(await FC.checkCutFramePair({ cut: { ...cut, end_frame: null } })).toMatchObject({ status: 'unchecked', issues: [] });
    verdicts([]);
    expect(await FC.checkCutFramePair({ cut })).toEqual({ status: 'pass', issues: [] });
    verdicts([{ kind: 'nonsense', frame_to_fix: 'middle', note: '  A man appears in **seat two**. ' }, { kind: 'layout', note: '' }]);
    const r = await FC.checkCutFramePair({ cut });
    expect(r.status).toBe('fail');
    expect(r.issues).toEqual([{ kind: 'other', severity: 'minor', frame_to_fix: 'end', note: 'A man appears in seat two.', fix_instruction: 'A man appears in seat two.' }]);
    verdicts(new Error('overloaded'));
    expect(await FC.checkCutFramePair({ cut })).toMatchObject({ status: 'unchecked', reason: 'overloaded' });
  });

  it('tells the checker what the cut performs: camera, action, block, both still prompts', async () => {
    const { cut } = await seedCut({ derive: true });
    verdicts([]);
    await FC.checkCutFramePair({ cut });
    const text = checks[0].text;
    expect(text).toContain('Camera: HELD (static)');
    expect(text).toContain('The one action: The clerk slides the bucket across the counter.');
    expect(text).toContain('Last-frame cell: The bucket rests in front of the boy.');
    expect(text).toContain('Medium shot at the counter');
    expect(text).toContain('First-frame prompt: The boy in the red windbreaker at the counter.');
    expect(text).toContain('Last-frame prompt (a change list applied to the first frame): Same frame. The bucket rests in front of the boy.');
    const pan = FC.buildFrameCheckText({ camera: { movement: 'pan', travel: 'from the box office to the counter' }, in_frame: [] });
    expect(pan).toContain('Camera: MOVING — pan, from the box office to the counter');
    expect(pan).not.toContain('Wardrobe locks');
    const locked = FC.buildFrameCheckText({ in_frame: [] }, { wardrobeLocks: 'Wardrobe lock — Sarah: grey wool coat' });
    expect(locked).toContain('Wardrobe locks (each still must match these words):\nWardrobe lock — Sarah: grey wool coat');
    expect(FC.FRAME_CHECK_SYSTEM_PROMPT).toMatch(/WARDROBE LOCK/);
    expect(FC.FRAME_CHECK_SYSTEM_PROMPT).toMatch(/Report every difference the cut does NOT perform/);
  });

  it('is switched off by CUT_FRAME_CHECK=off unless a checker is installed', async () => {
    const { beat, cut } = await seedCut();
    expect(process.env.CUT_FRAME_CHECK).toBe('off'); // tests/setup.js
    expect(FC.frameCheckEnabled()).toBe(false);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r).toMatchObject({ reason: 'disabled', repaired: false, frame_check: null });
    expect((await VP.getVideoPrompt(projectId, String(cut._id))).frame_check).toBeNull();
    await expect(SF.startCutFrameCheckJob({ projectId, cutId: String(cut._id) })).rejects.toThrow(/switched off/);
    verdicts([]);
    expect(FC.frameCheckEnabled()).toBe(true);
  });
});

describe('reconcileCutFrames', () => {
  it('a passing pair saves the verdict against the two images and edits nothing', async () => {
    const { beat, cut, startImg, endImg } = await seedCut();
    verdicts([]);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r.repaired).toBe(false);
    expect(dispatched).toEqual([]);
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.frame_check).toMatchObject({ status: 'pass', issues: [], rounds: 0 });
    expect(String(saved.frame_check.start_image_id)).toBe(String(startImg));
    expect(String(saved.frame_check.end_image_id)).toBe(String(endImg));
    expect(saved.frame_check.checked_at).toBeInstanceOf(Date);
    expect(FC.frameCheckIsCurrent(saved)).toBe(true);
    // A re-rendered frame makes the verdict stale.
    expect(FC.frameCheckIsCurrent({ ...saved, end_frame: { ...saved.end_frame, image_id: new ObjectId() } })).toBe(false);
  });

  it('repairs the END frame: an edit of it with the start frame as the reference, by the model that made it; Undo restores the original', async () => {
    const { beat, cut, startImg, endImg } = await seedCut();
    verdicts([WARDROBE], []);
    const events = [];
    const r = await FC.reconcileCutFrames({ projectId, beat, cut, onEvent: (t) => events.push(t) });
    expect(r.repaired).toBe(true);
    expect(checks).toHaveLength(2);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].mode).toBe('edit');
    expect(dispatched[0].model).toBe('flux-2-pro');
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['end-original', 'start-original']);
    expect(dispatched[0].prompt).toContain('The first image is the closing frame of a film shot. The second image is the opening frame of the same shot');
    expect(dispatched[0].prompt).toContain('never copy its framing or its poses');
    expect(dispatched[0].prompt).toContain('- Change the boy\'s grey T-shirt to the red zip windbreaker he wears in the other frame.');
    expect(events[0]).toMatch(/^repairing the end frame: The boy wears a grey T-shirt/);
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.frame_check).toMatchObject({ status: 'pass', rounds: 1, issues: [] });
    expect(bytes(saved.end_frame.image_id)).toBe('render-1');
    expect(String(saved.start_frame.image_id)).toBe(String(startImg));
    // The stored prompt is still the still prompt, not the repair instruction.
    expect(saved.end_frame.prompt).toBe('Same frame. The bucket rests in front of the boy.');
    expect(String(saved.end_frame.continuity_image_id)).toBe(String(startImg));
    // The second check looked at the repaired frame.
    expect(checks[1].end).toBe(String(saved.end_frame.image_id));
    const undone = await Gateway.undoVideoPromptStartFrameViaGateway({ projectId, promptId: String(cut._id), frame: 'end' });
    expect(String(undone.end_frame.image_id)).toBe(String(endImg));
  });

  it('repairs the START frame when the end frame has what the cut needs (both directions)', async () => {
    const { beat, cut, endImg } = await seedCut();
    verdicts([DISPENSER], []);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r.repaired).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].model).toBe('nano-banana-pro');
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['start-original', 'end-original']);
    expect(dispatched[0].prompt).toContain('The first image is the opening frame of a film shot. The second image is the closing frame of the same shot');
    expect(dispatched[0].prompt).toContain('- Add a steel butter dispenser at the left end of the counter');
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(bytes(saved.start_frame.image_id)).toBe('render-1');
    expect(String(saved.end_frame.image_id)).toBe(String(endImg));
    expect(saved.start_frame.prompt).toBe('The boy in the red windbreaker at the counter.');
  });

  it('a DERIVED end frame is re-derived from the repaired start frame instead of edited', async () => {
    const { beat, cut } = await seedCut({ derive: true });
    verdicts([DISPENSER, WARDROBE], []);
    await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(dispatched).toHaveLength(2);
    // 1: the start frame edited against the end frame. 2: the end frame made
    // again as an edit of the NEW start frame, from its change list.
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['start-original', 'end-original']);
    expect(dispatched[1].mode).toBe('edit');
    expect(dispatched[1].inputImages.map((i) => i.buffer.toString())).toEqual(['render-1']);
    expect(dispatched[1].prompt).toContain('Change only this:');
    expect(dispatched[1].prompt).toContain('The bucket rests in front of the boy.');
    expect(dispatched[1].prompt).not.toContain('T-shirt');
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.frame_check.status).toBe('pass');
    expect(String(saved.end_frame.continuity_image_id)).toBe(String(saved.start_frame.image_id));
  });

  it('stops after two repair rounds; the verdict stays "fail"; Undo still returns the frame from before the repairs', async () => {
    const { beat, cut, endImg } = await seedCut();
    verdicts([WARDROBE]);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(checks).toHaveLength(3);
    expect(dispatched).toHaveLength(2);
    expect(r.repaired).toBe(false);
    expect(r.frame_check).toMatchObject({ status: 'fail', rounds: 2 });
    expect(r.frame_check.issues).toHaveLength(1);
    // Round 2 edited round 1's frame, and round 1's frame was then dropped.
    expect(dispatched[1].inputImages[0].buffer.toString()).toBe('render-1');
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(bytes(saved.end_frame.image_id)).toBe('render-2');
    expect(String(saved.end_frame.previous_image_id)).toBe(String(endImg));
    expect(deleted).toHaveLength(1);
    expect(deleted).not.toContain(String(endImg));
  });

  it('the checker is given the cut\'s eyeline, intent and limits, and "intent" is a kind it can report', async () => {
    const { cut } = await seedCut();
    const text = FC.buildFrameCheckText({ ...cut, eyeline: 'On the doors, never the lens.', felt_intent: 'A kid in a hurry.', exclusions: ['Do not show his face from the front.'] });
    expect(text).toContain('Eyeline: On the doors, never the lens.');
    expect(text).toContain('Felt intent: A kid in a hurry.');
    expect(text).toContain('Limits: Do not show his face from the front.');
    expect(FC.FRAME_ISSUE_KINDS).toContain('intent');
    expect(FC.normalizeFrameIssues([{ kind: 'intent', frame_to_fix: 'start', note: 'They stroll.', fix_instruction: 'Make them stride.' }])[0].kind).toBe('intent');
    expect(FC.FRAME_CHECK_SYSTEM_PROMPT).toContain('EACH still against the cut itself');
  });

  it('a repair edit is told to lose nothing else', async () => {
    const { beat, cut } = await seedCut();
    verdicts([WARDROBE], []);
    await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(dispatched[0].prompt).toContain('Apart from those corrections, lose nothing');
  });

  it('one extra round when the last repair itself lost something; never for a fault that was there before', async () => {
    const { beat, cut } = await seedCut();
    const LOST = { kind: 'action_missing', frame_to_fix: 'end', note: 'The sedan with its headlights on is gone from the lane.', fix_instruction: 'Add the sedan back in the centre lane, headlights on.' };
    verdicts([WARDROBE], [WARDROBE], [LOST], []);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(dispatched).toHaveLength(3);
    expect(dispatched[2].prompt).toContain('- Add the sedan back in the centre lane, headlights on.');
    expect(r.frame_check).toMatchObject({ status: 'pass', rounds: 3 });
    // And it is one round only.
    dispatched.length = 0;
    checks.length = 0;
    const again = await seedCut();
    verdicts([WARDROBE], [WARDROBE], [LOST], [{ ...LOST, kind: 'prop_missing' }]);
    const r2 = await FC.reconcileCutFrames({ projectId, beat: again.beat, cut: again.cut });
    expect(dispatched).toHaveLength(3);
    expect(r2.frame_check).toMatchObject({ status: 'fail', rounds: 3 });
  });

  it('a sliding camera: the checker is told the slide, and a camera fault REBUILDS the end frame from the start frame', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Lot', body: 'The lot.' });
    const cut = await VP.createVideoPrompt({
      projectId, beatId: beat._id, title: 'Pan',
      camera: { size: 'wide', movement: 'pan', travel: 'right to left, from the marquee to the lot', travel_widths: 1 },
      prompt: 'Wide shot, the camera already panning left at one slow, even speed.',
      startFrame: { prompt: 'The marquee at the right.', image_id: img('start-original'), model: 'nano-banana-2' },
      endFrame: { prompt: 'The lot fills the frame.', image_id: img('end-original'), model: 'nano-banana-2' },
    });
    const CAMERA = { kind: 'camera', frame_to_fix: 'end', note: 'The last frame looks along the building from the far side of the lot.', fix_instruction: 'The canopy at the left edge should now sit right of centre, seen from the same spot.' };
    verdicts([CAMERA, WARDROBE], []);
    const events = [];
    await FC.reconcileCutFrames({ projectId, beat, cut, onEvent: (t) => events.push(t) });
    expect(checks[0].text).toContain('The move SLIDES the picture: the camera goes left');
    expect(checks[0].text).toContain('a third to a half of the frame');
    expect(events[0]).toMatch(/^rebuilding the end frame from the start frame: The last frame looks along/);
    // Not a patch of the end frame: it is built again FROM the start frame. A
    // new master plate is asked for first (these fake images cannot be
    // cropped), then the plain edit, guided by the checker's own sentence.
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toMatchObject({ mode: 'edit', aspectRatio: '21:9' });
    expect(dispatched[0].inputImages.map((i) => i.buffer.toString())).toEqual(['start-original']);
    expect(dispatched[1].inputImages.map((i) => i.buffer.toString())).toEqual(['start-original']);
    expect(dispatched[1].prompt).not.toContain('Make only these corrections');
    expect(dispatched[1].prompt).toContain('The lot fills the frame.');
    expect(dispatched[1].prompt).toContain('Where things end up: The canopy at the left edge should now sit right of centre, seen from the same spot.');
    const saved = await VP.getVideoPrompt(projectId, String(cut._id));
    expect(saved.frame_check.status).toBe('pass');
    expect(String(saved.end_frame.continuity_image_id)).toBe(String(saved.start_frame.image_id));
  });

  it('repair:false only checks; a cancel stops before the paid repair; a failed repair keeps the last verdict', async () => {
    let seeded = await seedCut();
    verdicts([WARDROBE]);
    let r = await FC.reconcileCutFrames({ projectId, beat: seeded.beat, cut: seeded.cut, repair: false });
    expect(dispatched).toEqual([]);
    expect(r.frame_check).toMatchObject({ status: 'fail', rounds: 0 });

    r = await FC.reconcileCutFrames({ projectId, beat: seeded.beat, cut: seeded.cut, shouldStop: () => true });
    expect(dispatched).toEqual([]);
    expect(r.frame_check.status).toBe('fail');

    SF._setStartFrameDispatcherForTests(async () => { throw new Error('provider down'); });
    const events = [];
    r = await FC.reconcileCutFrames({ projectId, beat: seeded.beat, cut: seeded.cut, onEvent: (t) => events.push(t) });
    expect(r.frame_check).toMatchObject({ status: 'fail', rounds: 1 });
    expect(events.at(-1)).toMatch(/repair failed: .*provider down/);
    const saved = await VP.getVideoPrompt(projectId, String(seeded.cut._id));
    expect(String(saved.end_frame.image_id)).toBe(String(seeded.endImg));
  });

  it('a checker error saves "unchecked" and never throws', async () => {
    const { beat, cut } = await seedCut();
    verdicts(new Error('boom'));
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r.frame_check.status).toBe('unchecked');
    expect(r.reason).toBe('boom');
    expect((await VP.getVideoPrompt(projectId, String(cut._id))).frame_check.status).toBe('unchecked');
  });
});

describe('jobs', () => {
  it('the bulk job checks each finished pair, repairs it, and reports the tally; a pair that still differs is a warning, not a failure', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Lobby', body: 'x' });
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'A', order: 1, startFrame: { prompt: 'A start.', references_planned: true }, endFrame: { prompt: 'A end.', references_planned: true } });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'B', order: 2, startFrame: { prompt: 'B start.', references_planned: true }, endFrame: { prompt: 'B end.', references_planned: true } });
    // Cut A: fails once then passes. Cut B: never passes.
    const seen = new Map();
    FC._setFrameCheckerForTests(async ({ cut }) => {
      const id = String(cut._id);
      const n = (seen.get(id) || 0) + 1;
      seen.set(id, n);
      if (id === String(a._id)) return { issues: n === 1 ? [WARDROBE] : [] };
      return { issues: [WARDROBE] };
    });
    const job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), frames: ['start', 'end'] }));
    expect(job.status).toBe('done');
    expect(job).toMatchObject({ planned: 4, rendered: 4, failed: 0 });
    expect(job.checks).toEqual({ passed: 1, failed: 1, repaired: 1, unchecked: 0, blocked: 0 });
    expect(job.warnings).toEqual([expect.stringMatching(/^Cut "B": the start and end frames still disagree after 2 repair rounds — The boy wears a grey T-shirt/)]);
    expect((await VP.getVideoPrompt(projectId, String(a._id))).frame_check).toMatchObject({ status: 'pass', rounds: 1 });
    expect((await VP.getVideoPrompt(projectId, String(b._id))).frame_check).toMatchObject({ status: 'fail', rounds: 2 });
  });

  it('a start-only run does not check; check:false skips it; existing frames never checked ARE checked; a current verdict is not repeated', async () => {
    const { beat, cut } = await seedCut();
    verdicts([]);
    let job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), frames: ['start'] }));
    expect(job.checks).toBeNull();
    job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), frames: ['start', 'end'], check: false }));
    expect(job.checks).toBeNull();
    expect(checks).toHaveLength(0);
    // Both frames exist (skipped), no verdict yet → checked.
    job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), frames: ['start', 'end'] }));
    expect(job).toMatchObject({ rendered: 0, skipped: 2 });
    expect(job.checks).toEqual({ passed: 1, failed: 0, repaired: 0, unchecked: 0, blocked: 0 });
    expect(checks).toHaveLength(1);
    // Same two images, verdict on file → not checked again.
    job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), frames: ['start', 'end'] }));
    expect(checks).toHaveLength(1);
    expect(job.checks).toEqual({ passed: 0, failed: 0, repaired: 0, unchecked: 0, blocked: 0 });
    expect((await VP.getVideoPrompt(projectId, String(cut._id))).frame_check.status).toBe('pass');
  });

  it('a single hand-made render is checked but never repaired', async () => {
    const { cut } = await seedCut();
    verdicts([WARDROBE]);
    const job = await waitJob(await SF.startSingleCutStartFrameJob({ projectId, cutId: String(cut._id), frame: 'end', prompt: 'The bucket in front of the boy.' }));
    expect(job.status).toBe('done');
    expect(dispatched).toHaveLength(1); // the render itself; no repair edit
    expect(checks).toHaveLength(1);
    expect(job.checks).toEqual({ passed: 0, failed: 1, repaired: 0, unchecked: 0, blocked: 0 });
    expect(job.warnings[0]).toMatch(/still disagree — The boy wears a grey T-shirt/);
  });

  it('startCutFrameCheckJob: needs both frames; check only vs repair; holds the beat lock', async () => {
    const { beat, cut } = await seedCut();
    verdicts([WARDROBE], []);
    const bare = await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'bare', startFrame: { prompt: 'x' } });
    await expect(SF.startCutFrameCheckJob({ projectId, cutId: String(bare._id) })).rejects.toThrow(/Render both/);
    await expect(SF.startCutFrameCheckJob({ projectId, cutId: String(new ObjectId()) })).rejects.toBeInstanceOf(SF.CutNotFoundError);

    let job = await waitJob(await SF.startCutFrameCheckJob({ projectId, cutId: String(cut._id) }));
    expect(job).toMatchObject({ status: 'done', kind: 'check', planned: 0, checks: { passed: 0, failed: 1, repaired: 0, unchecked: 0 } });
    expect(dispatched).toEqual([]);

    checks.length = 0;
    verdicts([WARDROBE], []);
    const id = await SF.startCutFrameCheckJob({ projectId, cutId: String(cut._id), repair: true });
    await expect(SF.startCutFrameCheckJob({ projectId, cutId: String(cut._id) })).rejects.toThrow();
    job = await waitJob(id);
    expect(job).toMatchObject({ status: 'done', kind: 'repair', checks: { passed: 1, failed: 0, repaired: 1, unchecked: 0 } });
    expect(dispatched).toHaveLength(1);
  });
});

describe('blocking problems', () => {
  const POPS_IN = { kind: 'person_added', severity: 'blocking', frame_to_fix: 'end', note: 'A man sits in the second seat only in the end frame.', fix_instruction: 'Remove the man in the second seat; show the empty red seat.' };
  const CROWD = { kind: 'crowd', severity: 'blocking', frame_to_fix: 'end', note: 'Second row: the woman in the yellow cardigan is a man in a grey hoodie.', fix_instruction: 'Every seat holds the same person as in the first frame.' };

  it('severity is kept, and defaults by kind when the checker gives none', () => {
    const out = FC.normalizeFrameIssues([
      { kind: 'crowd', frame_to_fix: 'end', note: 'different people' },
      { kind: 'light', frame_to_fix: 'end', note: 'warmer' },
      { kind: 'wardrobe', severity: 'blocking', frame_to_fix: 'end', note: 'jacket became a T-shirt' },
      { kind: 'person_added', severity: 'minor', frame_to_fix: 'end', note: 'a far figure' },
    ]);
    expect(out.map((i) => i.severity)).toEqual(['blocking', 'minor', 'blocking', 'minor']);
    expect(FC.FRAME_ISSUE_KINDS).toContain('crowd');
    expect(FC.FRAME_CHECK_SYSTEM_PROMPT).toMatch(/# Severity/);
    expect(FC.FRAME_CHECK_SYSTEM_PROMPT).toMatch(/seat by seat/);
    expect(FC.FRAME_CHECK_SYSTEM_PROMPT).not.toMatch(/the exact pose of a background extra/);
  });

  it('a blocking problem is retried up to six rounds and saved as blocking; a minor one still stops at two', async () => {
    const { beat, cut } = await seedCut();
    verdicts([POPS_IN]);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r.frame_check).toMatchObject({ status: 'fail', rounds: FC.DEFAULT_BLOCKING_ROUNDS, blocking: 1 });
    expect(dispatched).toHaveLength(6);
    expect((await VP.getVideoPrompt(projectId, String(cut._id))).frame_check.issues[0].severity).toBe('blocking');
    dispatched.length = 0;
    checks.length = 0;
    const minor = await seedCut();
    verdicts([WARDROBE]);
    const r2 = await FC.reconcileCutFrames({ projectId, beat: minor.beat, cut: minor.cut });
    expect(r2.frame_check).toMatchObject({ status: 'fail', rounds: 2, blocking: 0 });
  });

  it('once only minor issues remain the extra rounds stop', async () => {
    const { beat, cut } = await seedCut();
    verdicts([POPS_IN], [POPS_IN], [POPS_IN], [WARDROBE]);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r.frame_check).toMatchObject({ status: 'fail', rounds: 3, blocking: 0 });
  });

  it('CUT_FRAME_BLOCKING_ROUNDS sets the cap, clamped to 2–10', () => {
    const was = process.env.CUT_FRAME_BLOCKING_ROUNDS;
    try {
      delete process.env.CUT_FRAME_BLOCKING_ROUNDS;
      expect(FC.blockingRepairRounds()).toBe(6);
      process.env.CUT_FRAME_BLOCKING_ROUNDS = '9';
      expect(FC.blockingRepairRounds()).toBe(9);
      process.env.CUT_FRAME_BLOCKING_ROUNDS = '40';
      expect(FC.blockingRepairRounds()).toBe(10);
      process.env.CUT_FRAME_BLOCKING_ROUNDS = '1';
      expect(FC.blockingRepairRounds()).toBe(2);
    } finally {
      if (was === undefined) delete process.env.CUT_FRAME_BLOCKING_ROUNDS;
      else process.env.CUT_FRAME_BLOCKING_ROUNDS = was;
    }
  });

  it('patch edits for two rounds, then the end frame is REBUILT from the start frame (a moving camera: one edit of the start frame)', async () => {
    const { beat, cut, startImg } = await seedCut({ movement: 'push_in' });
    verdicts([POPS_IN], [POPS_IN], [POPS_IN], []);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r.frame_check).toMatchObject({ status: 'pass', rounds: 3 });
    expect(dispatched).toHaveLength(3);
    expect(dispatched[0].prompt).toContain('Make only these corrections');
    expect(dispatched[1].prompt).toContain('Make only these corrections');
    // Round 3: the start frame alone, edited into the closing frame.
    expect(dispatched[2].mode).toBe('edit');
    expect(dispatched[2].inputImages).toHaveLength(1);
    expect(dispatched[2].inputImages[0].buffer.toString()).toBe('start-original');
    expect(dispatched[2].prompt).toContain('never a different crowd of the same size');
    expect(dispatched[2].prompt).toContain('Remove the man in the second seat');
    expect(String(r.cut.end_frame.continuity_image_id)).toBe(String(startImg));
  });

  it('a crowd of different people rebuilds the end frame at once', async () => {
    const { beat, cut } = await seedCut({ movement: 'push_in' });
    verdicts([CROWD], []);
    const r = await FC.reconcileCutFrames({ projectId, beat, cut });
    expect(r.frame_check).toMatchObject({ status: 'pass', rounds: 1 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].inputImages[0].buffer.toString()).toBe('start-original');
    expect(dispatched[0].prompt).toContain('Produce the closing frame of the same shot');
  });

  it('the bulk job counts blocked pairs and marks their warning', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Lobby', body: 'x' });
    await VP.createVideoPrompt({ projectId, beatId: beat._id, title: 'A', order: 1, startFrame: { prompt: 'A start.', references_planned: true }, endFrame: { prompt: 'A end.', references_planned: true } });
    verdicts([POPS_IN]);
    const job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), frames: ['start', 'end'] }));
    expect(job.status).toBe('done');
    expect(job.checks).toEqual({ passed: 0, failed: 1, repaired: 0, unchecked: 0, blocked: 1 });
    expect(job.warnings[0]).toMatch(/^BLOCKING — Cut "A": the start and end frames still disagree after 6 repair rounds/);
  });
});

describe('a cut that continues the previous one', () => {
  async function seedChain() {
    const beat = await Plots.createBeat({ projectId, name: 'Row', body: 'x' });
    const sceneId = new ObjectId();
    const frames = (n) => ({ startFrame: { prompt: `${n} start.`, references_planned: true }, endFrame: { prompt: `${n} end.`, references_planned: true } });
    const a = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId, title: 'A', order: 1, ...frames('A') });
    const b = await VP.createVideoPrompt({ projectId, beatId: beat._id, sceneId, title: 'B', order: 2, continuesPrevious: true, ...frames('B') });
    return { beat, a, b };
  }

  it('opens on a copy of the previous cut\'s end frame, rendered in order', async () => {
    const { beat, a, b } = await seedChain();
    const job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), frames: ['start', 'end'], check: false }));
    expect(job).toMatchObject({ status: 'done', rendered: 4, failed: 0 });
    // A start, A end, B end — B's start frame is never sent to the image model.
    expect(dispatched.map((d) => d.prompt.includes('B start.'))).toEqual([false, false, false]);
    expect(dispatched).toHaveLength(3);
    const ra = await VP.getVideoPrompt(projectId, String(a._id));
    const rb = await VP.getVideoPrompt(projectId, String(b._id));
    expect(bytes(rb.start_frame.image_id)).toBe(bytes(ra.end_frame.image_id));
    expect(String(rb.start_frame.image_id)).not.toBe(String(ra.end_frame.image_id));
    expect(String(rb.start_frame.continuity_image_id)).toBe(String(ra.end_frame.image_id));
    expect(rb.start_frame.model).toBe('chained');
    expect(job.warnings).toEqual([]);
  });

  it('with no end frame before it, the start frame is rendered on its own and the job says so', async () => {
    const { beat, b } = await seedChain();
    const job = await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), cutIds: [String(b._id)], frames: ['start'] }));
    expect(job).toMatchObject({ rendered: 1 });
    expect(dispatched).toHaveLength(1);
    expect(job.warnings[0]).toMatch(/continues the previous cut, which has no end frame yet/);
  });

  it('a one-off prompt is the user\'s own frame and is not chained', async () => {
    const { beat, a, b } = await seedChain();
    await waitJob(await SF.startCutStartFramesJob({ projectId, beatId: String(beat._id), cutIds: [String(a._id)], frames: ['start', 'end'], check: false }));
    dispatched.length = 0;
    const fresh = await VP.getVideoPrompt(projectId, String(b._id));
    await SF.renderCutStartFrame({ projectId, cut: fresh, beat, frame: 'start', prompt: 'My own opening.' });
    expect(dispatched).toHaveLength(1);
  });
});
