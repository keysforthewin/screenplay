// Per-frame regen pipeline: validates the flow where each frame owns its own
// stored prompt and its own reference list. Frames are addressed by their
// stable per-frame id (not a start/end role).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub GridFS image-buffer reads so loadImageInput() returns a deterministic
// buffer keyed off the image id.
const imageBlobs = new Map();
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    const key = String(id);
    if (!imageBlobs.has(key)) return null;
    return imageBlobs.get(key);
  }),
  uploadGeneratedImage: vi.fn(async ({ filename }) => ({
    _id: new ObjectId(),
    filename,
    contentType: 'image/png',
    metadata: {},
  })),
}));

const Plots = await import('../src/mongo/plots.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Generate = await import('../src/web/storyboardGenerate.js');

beforeEach(() => {
  fakeDb.reset();
  imageBlobs.clear();
  Generate._setImageDispatcherForTests(null);
});

function registerImage(id) {
  const oid = id instanceof ObjectId ? id : new ObjectId(String(id));
  imageBlobs.set(String(oid), {
    buffer: Buffer.from(`bytes-${String(oid)}`),
    file: { contentType: 'image/png', metadata: {} },
  });
  return oid;
}

// Create a beat + storyboard + one frame. Returns the frame id so tests can
// address it. `imageId` seeds the frame's current image.
async function setupRow({ imageId = null, referenceIds = [] } = {}) {
  const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b' });
  const sb = await Storyboards.createStoryboard({
    beatId: beat._id,
    textPrompt: 'A wide shot of the diner.',
    shotType: 'cinematic_wide',
    charactersInScene: ['Alice'],
  });
  const { frameId } = await Storyboards.addFrame(sb._id, { imageId, referenceIds });
  return { beat, sb: await Storyboards.getStoryboard(sb._id), frameId };
}

function frameOf(sb, frameId) {
  return sb.frames.find((f) => f._id.toString() === String(frameId));
}

describe('regenerateStoryboardFrame (generate mode)', () => {
  it('sends the stored prompt + per-frame refs to the dispatcher and saves the prompt', async () => {
    const r1 = registerImage(new ObjectId());
    const r2 = registerImage(new ObjectId());
    const { sb, frameId } = await setupRow();
    await Storyboards.setFrameReferenceImages(sb._id, frameId, [r1, r2]);

    let captured;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId,
      imageModel: 'gemini',
      mode: 'generate',
      prompt: 'A wide shot of the diner at dusk.',
    });

    expect(captured.mode).toBe('generate');
    expect(captured.model).toBe('gemini');
    expect(captured.prompt).toBe('A wide shot of the diner at dusk.');
    expect(captured.inputImages).toHaveLength(2);

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(frameOf(fresh, frameId).prompt).toBe('A wide shot of the diner at dusk.');
    expect(frameOf(fresh, frameId).image_id).toBeTruthy();
  });

  it('keeps the reference lists of separate frames independent', async () => {
    const r1 = registerImage(new ObjectId());
    const r2 = registerImage(new ObjectId());
    const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b' });
    const sb = await Storyboards.createStoryboard({ beatId: beat._id });
    const f1 = (await Storyboards.addFrame(sb._id, {})).frameId;
    const f2 = (await Storyboards.addFrame(sb._id, {})).frameId;
    await Storyboards.setFrameReferenceImages(sb._id, f1, [r1]);
    await Storyboards.setFrameReferenceImages(sb._id, f2, [r2]);

    const captured = [];
    Generate._setImageDispatcherForTests(async (args) => {
      captured.push(args);
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId: f1,
      mode: 'generate',
      prompt: 'first prompt',
    });
    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId: f2,
      mode: 'generate',
      prompt: 'second prompt',
    });

    expect(captured[0].inputImages).toHaveLength(1);
    expect(captured[1].inputImages).toHaveLength(1);
    expect(captured[0].inputImages[0].buffer.toString()).not.toBe(
      captured[1].inputImages[0].buffer.toString(),
    );

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(frameOf(fresh, f1).prompt).toBe('first prompt');
    expect(frameOf(fresh, f2).prompt).toBe('second prompt');
  });

  it('requires a non-empty prompt for generate mode', async () => {
    const { sb, frameId } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        frameId,
        mode: 'generate',
        prompt: '   ',
      }),
    ).rejects.toThrow(/non-empty prompt/);
  });
});

describe('regenerateStoryboardFrame (edit mode)', () => {
  it('passes only the existing frame plus the edit prompt — no references', async () => {
    const refId = registerImage(new ObjectId());
    const startId = registerImage(new ObjectId());
    const { sb, frameId } = await setupRow({ imageId: startId });
    await Storyboards.setFrameReferenceImages(sb._id, frameId, [refId]);

    let captured;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId,
      mode: 'edit',
      editPrompt: 'remove the lamp on the left',
    });

    expect(captured.mode).toBe('edit');
    expect(captured.prompt).toBe('remove the lamp on the left');
    expect(captured.inputImages).toHaveLength(1);
    expect(captured.inputImages[0].buffer.toString()).toBe(
      imageBlobs.get(String(startId)).buffer.toString(),
    );
  });

  it('does NOT save the edit prompt into the stored frame prompt', async () => {
    const startId = registerImage(new ObjectId());
    const { sb, frameId } = await setupRow({ imageId: startId });
    await Storyboards.setFramePrompt(sb._id, frameId, 'original stored prompt');
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      frameId,
      mode: 'edit',
      editPrompt: 'tweak',
    });

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(frameOf(fresh, frameId).prompt).toBe('original stored prompt');
  });

  it('throws when there is no existing image to edit', async () => {
    const { sb, frameId } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        frameId,
        mode: 'edit',
        editPrompt: 'tweak',
      }),
    ).rejects.toThrow(/No existing/);
  });

  it('throws on empty editPrompt', async () => {
    const startId = registerImage(new ObjectId());
    const { sb, frameId } = await setupRow({ imageId: startId });
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        frameId,
        mode: 'edit',
        editPrompt: '   ',
      }),
    ).rejects.toThrow(/non-empty editPrompt/);
  });
});

describe('regenerateStoryboardFrame error gates', () => {
  it('rejects an unknown frame id', async () => {
    const { sb } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        frameId: new ObjectId(),
        mode: 'generate',
        prompt: 'x',
      }),
    ).rejects.toThrow(/frame not found/i);
  });

  it('rejects unknown modes', async () => {
    const { sb, frameId } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        frameId,
        mode: 'custom',
        prompt: 'x',
      }),
    ).rejects.toThrow(/Unknown regen mode/);
  });
});

describe('previewFrameGenerationPrompt', () => {
  it('returns the stored prompt when set, plus a freshly built suggestion', async () => {
    const { sb, frameId } = await setupRow();
    await Storyboards.setFramePrompt(sb._id, frameId, 'user-typed prompt');
    const r = await Generate.previewFrameGenerationPrompt({
      storyboardId: sb._id,
      frameId,
    });
    expect(r.prompt).toBe('user-typed prompt');
    expect(r.has_stored_prompt).toBe(true);
    expect(r.suggested_prompt).toMatch(/cinematic_wide|wide shot/i);
  });

  it('falls back to the suggested prompt when stored is empty', async () => {
    const { sb, frameId } = await setupRow();
    const r = await Generate.previewFrameGenerationPrompt({
      storyboardId: sb._id,
      frameId,
    });
    expect(r.has_stored_prompt).toBe(false);
    expect(r.prompt).toBe(r.suggested_prompt);
    expect(r.prompt).toMatch(/cinematic_wide|wide shot/i);
  });
});

describe('startFrameGenerationJob', () => {
  it('queues a job and reaches status=done after the worker runs', async () => {
    const { sb, frameId } = await setupRow();
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));
    const jobId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id,
      frameId,
      mode: 'generate',
      prompt: 'a prompt',
    });
    for (let i = 0; i < 200; i++) {
      const job = Generate.getFrameGenerationJob(jobId);
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const job = Generate.getFrameGenerationJob(jobId);
    expect(job.status).toBe('done');
    expect(job.image_id).toBeTruthy();
  });

  it('rejects edit mode on an empty frame before queuing', async () => {
    const { sb, frameId } = await setupRow();
    await expect(
      Generate.startFrameGenerationJob({
        storyboardId: sb._id,
        frameId,
        mode: 'edit',
        editPrompt: 'tweak',
      }),
    ).rejects.toThrow(/No existing/);
  });

  it('rejects unknown mode at the gate', async () => {
    const { sb, frameId } = await setupRow();
    await expect(
      Generate.startFrameGenerationJob({
        storyboardId: sb._id,
        frameId,
        mode: 'custom',
        prompt: 'x',
      }),
    ).rejects.toThrow(/Unknown regen mode/);
  });

  it('rotates current → previous when rotateToPrevious=true on an edit', async () => {
    const startId = registerImage(new ObjectId());
    const { sb, frameId } = await setupRow({ imageId: startId });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('edited'),
      contentType: 'image/png',
    }));
    const jobId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id,
      frameId,
      mode: 'edit',
      editPrompt: 'add a hat',
      rotateToPrevious: true,
    });
    for (let i = 0; i < 200; i++) {
      const job = Generate.getFrameGenerationJob(jobId);
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const job = Generate.getFrameGenerationJob(jobId);
    expect(job.status).toBe('done');
    const fresh = await Storyboards.getStoryboard(sb._id);
    const f = frameOf(fresh, frameId);
    expect(f.previous_image_id.toString()).toBe(startId.toString());
    expect(f.image_id.toString()).not.toBe(startId.toString());
    expect(f.last_edit_prompt).toBe('add a hat');
  });

  it('does NOT rotate when rotateToPrevious=false (regenerate path)', async () => {
    const startId = registerImage(new ObjectId());
    const { sb, frameId } = await setupRow({ imageId: startId });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('regen'),
      contentType: 'image/png',
    }));
    const jobId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id,
      frameId,
      mode: 'generate',
      prompt: 'fresh take',
    });
    for (let i = 0; i < 200; i++) {
      const job = Generate.getFrameGenerationJob(jobId);
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const fresh = await Storyboards.getStoryboard(sb._id);
    const f = frameOf(fresh, frameId);
    expect(f.previous_image_id).toBe(null);
    expect(f.last_edit_prompt).toBe('');
  });
});
