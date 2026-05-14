// Per-frame regen pipeline: validates the new minimal flow where each frame
// owns its own stored prompt and its own reference list. Heavily simplified
// vs. the legacy multi-mode pipeline — character_sheet, custom mode, and
// continuity anchors are gone.

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
// buffer keyed off the image id. Our fake stores per-image metadata only;
// imageBytes lookups happen via this mock so tests don't need a real bucket.
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

async function setupRow({ startFrameId = null, endFrameId = null } = {}) {
  const beat = await Plots.createBeat({ name: 'Diner', desc: 'd', body: 'b' });
  const sb = await Storyboards.createStoryboard({
    beatId: beat._id,
    textPrompt: 'A wide shot of the diner.',
    shotType: 'cinematic_wide',
    charactersInScene: ['Alice'],
  });
  if (startFrameId) {
    await Storyboards.updateStoryboard(sb._id, { start_frame_id: startFrameId });
  }
  if (endFrameId) {
    await Storyboards.updateStoryboard(sb._id, { end_frame_id: endFrameId });
  }
  return { beat, sb: await Storyboards.getStoryboard(sb._id) };
}

describe('regenerateStoryboardFrame (generate mode)', () => {
  it('sends the stored prompt + per-frame refs to the dispatcher and saves the prompt', async () => {
    const r1 = registerImage(new ObjectId());
    const r2 = registerImage(new ObjectId());
    const { sb } = await setupRow();
    await Storyboards.setFrameReferenceImages(sb._id, 'start_frame', [r1, r2]);

    let captured;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      role: 'start_frame',
      imageModel: 'gemini',
      mode: 'generate',
      prompt: 'A wide shot of the diner at dusk.',
    });

    expect(captured.mode).toBe('generate');
    expect(captured.model).toBe('gemini');
    expect(captured.prompt).toBe('A wide shot of the diner at dusk.');
    expect(captured.inputImages).toHaveLength(2);

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.start_frame_prompt).toBe('A wide shot of the diner at dusk.');
    expect(fresh.start_frame_id).toBeTruthy();
  });

  it('keeps start_frame and end_frame reference lists independent', async () => {
    const r1 = registerImage(new ObjectId());
    const r2 = registerImage(new ObjectId());
    const { sb } = await setupRow();
    await Storyboards.setFrameReferenceImages(sb._id, 'start_frame', [r1]);
    await Storyboards.setFrameReferenceImages(sb._id, 'end_frame', [r2]);

    let captured = [];
    Generate._setImageDispatcherForTests(async (args) => {
      captured.push(args);
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      role: 'start_frame',
      mode: 'generate',
      prompt: 'start prompt',
    });
    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      role: 'end_frame',
      mode: 'generate',
      prompt: 'end prompt',
    });

    expect(captured[0].inputImages).toHaveLength(1);
    expect(captured[1].inputImages).toHaveLength(1);
    expect(captured[0].inputImages[0].buffer.toString()).not.toBe(
      captured[1].inputImages[0].buffer.toString(),
    );

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.start_frame_prompt).toBe('start prompt');
    expect(fresh.end_frame_prompt).toBe('end prompt');
  });

  it('requires a non-empty prompt for generate mode', async () => {
    const { sb } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        role: 'start_frame',
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
    const { sb } = await setupRow({ startFrameId: startId });
    await Storyboards.setFrameReferenceImages(sb._id, 'start_frame', [refId]);

    let captured;
    Generate._setImageDispatcherForTests(async (args) => {
      captured = args;
      return { buffer: Buffer.from('img'), contentType: 'image/png' };
    });

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      role: 'start_frame',
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
    const { sb } = await setupRow({ startFrameId: startId });
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_prompt: 'original stored prompt',
    });
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));

    await Generate.regenerateStoryboardFrame({
      storyboardId: sb._id,
      role: 'start_frame',
      mode: 'edit',
      editPrompt: 'tweak',
    });

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.start_frame_prompt).toBe('original stored prompt');
  });

  it('throws when there is no existing image to edit', async () => {
    const { sb } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        role: 'start_frame',
        mode: 'edit',
        editPrompt: 'tweak',
      }),
    ).rejects.toThrow(/No existing/);
  });

  it('throws on empty editPrompt', async () => {
    const startId = registerImage(new ObjectId());
    const { sb } = await setupRow({ startFrameId: startId });
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        role: 'start_frame',
        mode: 'edit',
        editPrompt: '   ',
      }),
    ).rejects.toThrow(/non-empty editPrompt/);
  });
});

describe('regenerateStoryboardFrame error gates', () => {
  it('rejects unknown roles', async () => {
    const { sb } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        role: 'character_sheet',
        mode: 'generate',
        prompt: 'x',
      }),
    ).rejects.toThrow(/unsupported frame role/);
  });

  it('rejects unknown modes', async () => {
    const { sb } = await setupRow();
    await expect(
      Generate.regenerateStoryboardFrame({
        storyboardId: sb._id,
        role: 'start_frame',
        mode: 'custom',
        prompt: 'x',
      }),
    ).rejects.toThrow(/Unknown regen mode/);
  });
});

describe('previewFrameGenerationPrompt', () => {
  it('returns the stored prompt when set, plus a freshly built suggestion', async () => {
    const { sb } = await setupRow();
    await Storyboards.updateStoryboard(sb._id, {
      start_frame_prompt: 'user-typed prompt',
    });
    const r = await Generate.previewFrameGenerationPrompt({
      storyboardId: sb._id,
      role: 'start_frame',
    });
    expect(r.prompt).toBe('user-typed prompt');
    expect(r.has_stored_prompt).toBe(true);
    expect(r.suggested_prompt).toMatch(/cinematic_wide|wide shot/i);
  });

  it('falls back to the suggested prompt when stored is empty', async () => {
    const { sb } = await setupRow();
    const r = await Generate.previewFrameGenerationPrompt({
      storyboardId: sb._id,
      role: 'end_frame',
    });
    expect(r.has_stored_prompt).toBe(false);
    expect(r.prompt).toBe(r.suggested_prompt);
    expect(r.prompt).toMatch(/cinematic_wide|wide shot/i);
  });
});

describe('startFrameGenerationJob', () => {
  it('queues a job and reaches status=done after the worker runs', async () => {
    const { sb } = await setupRow();
    Generate._setImageDispatcherForTests(async () => ({
      buffer: Buffer.from('img'),
      contentType: 'image/png',
    }));
    const jobId = await Generate.startFrameGenerationJob({
      storyboardId: sb._id,
      role: 'start_frame',
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

  it('rejects edit mode on an empty slot before queuing', async () => {
    const { sb } = await setupRow();
    await expect(
      Generate.startFrameGenerationJob({
        storyboardId: sb._id,
        role: 'start_frame',
        mode: 'edit',
        editPrompt: 'tweak',
      }),
    ).rejects.toThrow(/No existing/);
  });

  it('rejects unknown mode at the gate', async () => {
    const { sb } = await setupRow();
    await expect(
      Generate.startFrameGenerationJob({
        storyboardId: sb._id,
        role: 'start_frame',
        mode: 'custom',
        prompt: 'x',
      }),
    ).rejects.toThrow(/Unknown regen mode/);
  });
});
