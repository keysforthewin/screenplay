// Tests for the playground generation orchestrator. The fal client is mocked
// so we can drive submit / status / result paths; GridFS helpers are mocked
// with in-memory stores (same pattern as tests/fal-video-generate.test.js).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// keyed by id string → { buffer, contentType, metadata }
const fakeImageStore = new Map();
const fakeAttachmentStore = new Map();
const storedImages = [];
const storedAttachments = [];

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async (id) => {
    const entry = fakeImageStore.get(String(id));
    if (!entry) return null;
    return { buffer: entry.buffer, file: { _id: id, metadata: entry.metadata } };
  }),
  uploadGeneratedImage: vi.fn(async (_projectId, args) => {
    const file = { _id: new ObjectId(), content_type: args.contentType, metadata: { owner_type: args.ownerType } };
    storedImages.push({ ...args, _id: file._id });
    return file;
  }),
}));

vi.mock('../src/mongo/attachments.js', () => ({
  readAttachmentBuffer: vi.fn(async (id) => {
    const entry = fakeAttachmentStore.get(String(id));
    if (!entry) return null;
    return { buffer: entry.buffer, file: { _id: id, metadata: entry.metadata } };
  }),
  uploadAttachmentBuffer: vi.fn(async (_projectId, args) => {
    const file = { _id: new ObjectId(), filename: args.filename, content_type: args.contentType };
    storedAttachments.push({ ...args, _id: file._id });
    return file;
  }),
}));

let falStubs;
function resetFalStubs() {
  falStubs = {
    configured: true,
    submitCalls: [],
    subscribeImpl: async () => undefined,
    resultImpl: async () => ({ data: { images: [{ url: 'https://fal.media/out.png' }] } }),
  };
}
resetFalStubs();

vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => falStubs.configured,
  fal: {
    storage: {
      upload: vi.fn(async (file) => `https://fal.media/inputs/${file?.name || 'asset'}`),
    },
    queue: {
      submit: vi.fn(async (model, args) => {
        falStubs.submitCalls.push({ model, args });
        return { request_id: 'req-pg-1' };
      }),
      subscribeToStatus: vi.fn(async (model, args) => falStubs.subscribeImpl(model, args)),
      result: vi.fn(async (model, args) => falStubs.resultImpl(model, args)),
    },
  },
}));

const realFetch = global.fetch;
let fetchContentType = 'image/png';
function installFetchMock() {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => fetchContentType },
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  }));
}

const Playground = await import('../src/web/playgroundGenerate.js');

const PROJECT_A = new ObjectId().toString();
const PROJECT_B = new ObjectId().toString();

let catalogPath;
const T2I = {
  endpoint_id: 'test/t2i',
  display_name: 'Test T2I',
  output: { kind: 'image', path: 'images[0].url' },
  inputs: {
    prompt: 'required',
    prompt_param: 'prompt',
    image: { need: 'unused', params: [], required_count: 0, max: 0 },
    audio: { need: 'unused', param: null, list: false },
    video: { need: 'unused', param: null, list: false },
  },
  defaults: {},
};
const T2I_SIZED = {
  endpoint_id: 'test/t2i-sized',
  display_name: 'Test T2I Sized',
  output: { kind: 'image', path: 'images[0].url' },
  inputs: {
    prompt: 'required',
    prompt_param: 'prompt',
    image: { need: 'unused', params: [], required_count: 0, max: 0 },
    audio: { need: 'unused', param: null, list: false },
    video: { need: 'unused', param: null, list: false },
  },
  controls: [
    { name: 'image_size', type: 'enum', options: ['square_hd', 'portrait_16_9'], default: 'square_hd' },
  ],
  defaults: {},
};
const I2V = {
  endpoint_id: 'test/i2v',
  display_name: 'Test I2V',
  output: { kind: 'video', path: 'video.url' },
  inputs: {
    prompt: 'optional',
    prompt_param: 'prompt',
    image: { need: 'required', params: [{ name: 'image_url', list: false, required: true }], required_count: 1, max: 1 },
    audio: { need: 'unused', param: null, list: false },
    video: { need: 'unused', param: null, list: false },
  },
  defaults: {},
};

beforeEach(async () => {
  fakeDb.reset();
  fakeImageStore.clear();
  fakeAttachmentStore.clear();
  storedImages.length = 0;
  storedAttachments.length = 0;
  resetFalStubs();
  installFetchMock();
  fetchContentType = 'image/png';
  const dir = await mkdtemp(path.join(tmpdir(), 'pg-gen-'));
  catalogPath = path.join(dir, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ generated_at: 'now', models: [T2I, T2I_SIZED, I2V] }));
});

async function waitForTerminal(jobId, timeoutMs = 2000) {
  const startedAt = Date.now();
  for (;;) {
    const job = Playground.getPlaygroundJob(jobId);
    if (job && (job.status === 'done' || job.status === 'error')) return job;
    if (Date.now() - startedAt > timeoutMs) throw new Error('job never finished');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function seedImageRef(projectId) {
  const id = new ObjectId().toString();
  fakeImageStore.set(id, {
    buffer: Buffer.from([9, 9, 9]),
    contentType: 'image/png',
    metadata: { project_id: projectId, owner_type: 'playground', content_type: 'image/png' },
  });
  return id;
}

describe('startPlaygroundJob', () => {
  it('runs a text-to-image job to done and persists the image', async () => {
    const { job_id } = await Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i', prompt: 'a fish', catalogPath,
    });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('done');
    expect(falStubs.submitCalls[0].model).toBe('test/t2i');
    expect(falStubs.submitCalls[0].args.input).toEqual({ prompt: 'a fish' });
    expect(storedImages).toHaveLength(1);
    expect(storedImages[0].ownerType).toBe('playground');
    expect(storedImages[0].generatedBy).toBe('test/t2i');
    const snap = Playground.serializePlaygroundJob(job);
    expect(snap.outputs).toEqual([{ kind: 'image', file_id: storedImages[0]._id.toString() }]);
  });

  it('uploads image refs to fal and persists a video output to attachments', async () => {
    fetchContentType = 'video/mp4';
    falStubs.resultImpl = async () => ({ data: { video: { url: 'https://fal.media/out.mp4' } } });
    const refId = seedImageRef(PROJECT_A);
    const { job_id } = await Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/i2v', prompt: 'move it',
      refs: [{ file_id: refId, kind: 'image' }], catalogPath,
    });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('done');
    expect(falStubs.submitCalls[0].args.input.image_url).toMatch(/^https:\/\/fal\.media\/inputs\//);
    expect(storedAttachments).toHaveLength(1);
    expect(storedAttachments[0].ownerType).toBe('playground');
    expect(storedAttachments[0].contentType).toBe('video/mp4');
    // Model + prompt are stamped so the history endpoint can tell outputs
    // apart from reference uploads.
    expect(storedAttachments[0].generatedBy).toBe('test/i2v');
    expect(storedAttachments[0].prompt).toBe('move it');
  });

  it('rejects a ref belonging to another project as a job error', async () => {
    const refId = seedImageRef(PROJECT_B);
    const { job_id } = await Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/i2v',
      refs: [{ file_id: refId, kind: 'image' }], catalogPath,
    });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/reference/i);
    expect(falStubs.submitCalls).toHaveLength(0);
  });

  it('throws UnknownPlaygroundModelError for a model not in the catalog', async () => {
    await expect(Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/nope', prompt: 'x', catalogPath,
    })).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' });
  });

  it('throws PlaygroundMissingInputsError when required inputs are absent', async () => {
    await expect(Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i', prompt: '', catalogPath,
    })).rejects.toMatchObject({ code: 'MISSING_INPUTS', missing: ['prompt'] });
    await expect(Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/i2v', refs: [], catalogPath,
    })).rejects.toMatchObject({ code: 'MISSING_INPUTS', missing: ['image'] });
  });

  it('passes validated control options into the fal input', async () => {
    const { job_id } = await Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i-sized', prompt: 'a fish',
      options: { image_size: 'portrait_16_9' }, catalogPath,
    });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('done');
    expect(falStubs.submitCalls[0].args.input)
      .toEqual({ prompt: 'a fish', image_size: 'portrait_16_9' });
  });

  it('rejects invalid control options with BAD_OPTIONS', async () => {
    await expect(Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i-sized', prompt: 'x',
      options: { image_size: 'gigantic' }, catalogPath,
    })).rejects.toMatchObject({ code: 'BAD_OPTIONS' });
  });

  it('throws PlaygroundNotConfiguredError without a fal key', async () => {
    falStubs.configured = false;
    await expect(Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i', prompt: 'x', catalogPath,
    })).rejects.toMatchObject({ code: 'FAL_NOT_CONFIGURED' });
  });

  it('surfaces fal ApiError body.detail instead of the bare status text', async () => {
    falStubs.resultImpl = async () => {
      const err = new Error('Unprocessable Entity');
      err.status = 422;
      err.body = {
        detail: [{
          loc: ['body', 'prompt'],
          msg: 'Could not generate a video with the given inputs. Please try again with different inputs.',
          type: 'invalid_request',
        }],
      };
      throw err;
    };
    const { job_id } = await Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i', prompt: 'x', catalogPath,
    });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/Could not generate a video with the given inputs/);
    expect(job.error).toMatch(/Test T2I/);
    expect(job.error).not.toBe('Unprocessable Entity');
  });

  it('surfaces fal queue failures as job errors', async () => {
    falStubs.subscribeImpl = async () => { throw new Error('boom at fal'); };
    const { job_id } = await Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i', prompt: 'x', catalogPath,
    });
    const job = await waitForTerminal(job_id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/boom at fal/);
  });

  it('fans out snapshots to subscribers and stops after unsubscribe', async () => {
    const seen = [];
    const cb = (snap) => seen.push(snap.status);
    const { job_id } = await Playground.startPlaygroundJob({
      projectId: PROJECT_A, modelId: 'test/t2i', prompt: 'x', catalogPath,
    });
    Playground.subscribeToPlaygroundJob(job_id, cb);
    await waitForTerminal(job_id);
    expect(seen).toContain('done');
    const countAtDone = seen.length;
    Playground.unsubscribeFromPlaygroundJob(job_id, cb);
    expect(seen.length).toBe(countAtDone);
  });
});
