// Provider-routing tests for generate_image / edit_image.
//
// Verifies that:
//   - Default (no provider) → nano-banana-pro path (FAL), records fal_image
//     usage, stamps fal-ai/nano-banana-pro as generated_by.
//   - provider: 'openai' → OpenAI gpt-image-2 path, records openai_image
//     usage, stamps gpt-image-2 as generated_by, and routes to images.edits
//     when a source_image_id is present.
//   - provider: 'openai' with OPENAI_API_KEY unset → friendly error string,
//     no model call.
//   - The dispatch helper does NOT silently fall back: an unconfigured FAL
//     does not get rescued by a configured OpenAI (or vice versa).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const falNanoBananaProCalls = [];
const falFlux2ProCalls = [];
const falKontextCalls = [];
vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: async (args) => {
    falNanoBananaProCalls.push(args);
    const hasInput = (args.inputImages || []).length > 0;
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      model: hasInput ? 'fal-ai/nano-banana-pro/edit' : 'fal-ai/nano-banana-pro',
    };
  },
  generateFlux2ProImage: async (args) => {
    falFlux2ProCalls.push(args);
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      model: 'fal-ai/flux-2-pro',
    };
  },
  generateFluxKontextImage: async (args) => {
    falKontextCalls.push(args);
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      model: 'fal-ai/flux-pro/kontext',
    };
  },
  NANO_BANANA_PRO_GENERATE_MODEL: 'fal-ai/nano-banana-pro',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
}));

const falConfigured = vi.fn(() => true);
vi.mock('../src/fal/client.js', () => ({
  isConfigured: (...a) => falConfigured(...a),
}));

const openaiGenerateCalls = [];
const openaiEditCalls = [];
vi.mock('../src/openai/imageClient.js', () => ({
  GPT_IMAGE_MODEL: 'gpt-image-2',
  generateCharacterSheetImage: async (args) => {
    openaiGenerateCalls.push(args);
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      model: 'gpt-image-2',
      latencyMs: 50,
      usage: { input_tokens: 12, output_tokens: 500, total_tokens: 512 },
    };
  },
  generateCharacterSheetImageEdit: async (args) => {
    openaiEditCalls.push(args);
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
      contentType: 'image/png',
      model: 'gpt-image-2',
      latencyMs: 50,
      usage: { input_tokens: 30, output_tokens: 500, total_tokens: 530 },
    };
  },
}));

// In-memory GridFS stand-in mirroring tests/editImage.test.js.
const fakeBucket = new Map();
const uploads = [];

vi.mock('../src/mongo/images.js', async () => ({
  readImageBuffer: async (id) => {
    const key = id instanceof ObjectId ? id.toString() : String(id);
    return fakeBucket.get(key) || null;
  },
  uploadGeneratedImage: async (_projectId, { buffer, contentType, prompt, generatedBy, ownerType, ownerId }) => {
    const _id = new ObjectId();
    uploads.push({ _id, ownerType, ownerId, prompt, generatedBy, contentType });
    const file = {
      _id,
      filename: `gen-${_id}.png`,
      contentType,
      length: buffer.length,
      metadata: { owner_type: ownerType, owner_id: ownerId || null },
      uploadDate: new Date(),
    };
    fakeBucket.set(_id.toString(), { buffer, file });
    return {
      _id,
      filename: file.filename,
      content_type: contentType,
      size: buffer.length,
      uploaded_at: file.uploadDate,
    };
  },
  streamImageToTmp: async (id) => ({ path: `/tmp/${id}.png` }),
  deleteImage: async () => {},
}));

vi.mock('../src/web/gateway.js', () => ({
  addLibraryImageViaGateway: async () => {},
}));
vi.mock('../src/web/libraryVisionWorker.js', () => ({
  kickoffLibraryVisionSeed: () => {},
}));

// Hold the config mock as a mutable object so individual tests can flip
// provider keys on/off without re-mocking.
const mockConfig = {
  gemini: { apiKey: null, vertex: { project: null, location: null } },
  openai: { apiKey: 'fake-openai-key', imageTimeoutMs: 600_000 },
  discord: { movieChannelId: 'cX' },
  fal: {
    apiKey: 'fake-fal-key',
    nanoBananaProGenerateModel: 'fal-ai/nano-banana-pro',
    nanoBananaProEditModel: 'fal-ai/nano-banana-pro/edit',
    flux2ProGenerateModel: 'fal-ai/flux-2-pro',
    flux2ProEditModel: 'fal-ai/flux-2-pro/edit',
    fluxKontextModel: 'fal-ai/flux-pro/kontext',
    fluxKontextMultiModel: 'fal-ai/flux-pro/kontext/multi',
  },
};
vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    get config() {
      return { ...real.config, ...mockConfig };
    },
  };
});

const { HANDLERS } = await import('../src/agent/handlers.js');
const { createProject } = await import('../src/mongo/projects.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  fakeBucket.clear();
  uploads.length = 0;
  falNanoBananaProCalls.length = 0;
  falFlux2ProCalls.length = 0;
  falKontextCalls.length = 0;
  openaiGenerateCalls.length = 0;
  openaiEditCalls.length = 0;
  falConfigured.mockReturnValue(true);
  mockConfig.openai = { apiKey: 'fake-openai-key', imageTimeoutMs: 600_000 };
});

async function seedLibraryImage() {
  const _id = new ObjectId();
  fakeBucket.set(_id.toString(), {
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]),
    file: {
      _id,
      filename: `seed-${_id}.png`,
      contentType: 'image/png',
      length: 5,
      metadata: { owner_type: null, owner_id: null, contentType: 'image/png' },
      uploadDate: new Date(),
    },
  });
  return _id;
}

describe('generate_image provider routing', () => {
  it('defaults to nano-banana-pro (FAL) when provider is omitted', async () => {
    const out = await HANDLERS.generate_image(
      { prompt: 'a cathedral at dusk' },
      { projectId, discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' });
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(falNanoBananaProCalls).toHaveLength(1);
    expect(openaiGenerateCalls).toHaveLength(0);
    expect(uploads[0].generatedBy).toBe('fal-ai/nano-banana-pro');

    const tokenDocs = fakeDb.collection('token_usage')._docs;
    expect(tokenDocs).toHaveLength(1);
    expect(tokenDocs[0].kind).toBe('fal_image');
    expect(tokenDocs[0].model).toBe('fal-ai/nano-banana-pro');
  });

  it("routes provider: 'openai' to gpt-image-2 generate endpoint", async () => {
    const out = await HANDLERS.generate_image(
      { prompt: 'a cathedral at dusk', provider: 'openai' },
      { projectId, discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' });
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(falNanoBananaProCalls).toHaveLength(0);
    expect(openaiGenerateCalls).toHaveLength(1);
    expect(openaiEditCalls).toHaveLength(0);
    expect(openaiGenerateCalls[0].prompt).toContain('cathedral at dusk');
    expect(openaiGenerateCalls[0].size).toBe('1536x1024');
    expect(openaiGenerateCalls[0].quality).toBe('auto');

    expect(uploads[0].generatedBy).toBe('gpt-image-2');

    const tokenDocs = fakeDb.collection('token_usage')._docs;
    expect(tokenDocs).toHaveLength(1);
    expect(tokenDocs[0].kind).toBe('openai_image');
    expect(tokenDocs[0].model).toBe('gpt-image-2');
    expect(tokenDocs[0].tokens).toBe(512);
  });

  it("routes provider: 'openai' with source_image_id to the edit endpoint", async () => {
    const sourceId = await seedLibraryImage();

    const out = await HANDLERS.generate_image(
      {
        prompt: 'recolor the cathedral',
        provider: 'openai',
        source_image_id: sourceId.toString(),
      },
      { projectId, discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' });
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(openaiGenerateCalls).toHaveLength(0);
    expect(openaiEditCalls).toHaveLength(1);
    expect(openaiEditCalls[0].inputImages).toHaveLength(1);
    expect(openaiEditCalls[0].inputImages[0].contentType).toBe('image/png');
  });

  it('maps aspect_ratio to the closest gpt-image-2 size', async () => {
    await HANDLERS.generate_image(
      { prompt: 'wide shot', provider: 'openai', aspect_ratio: '9:16' },
      { projectId });
    expect(openaiGenerateCalls[0].size).toBe('1024x1536');

    openaiGenerateCalls.length = 0;
    await HANDLERS.generate_image(
      { prompt: 'square', provider: 'openai', aspect_ratio: '1:1' },
      { projectId });
    expect(openaiGenerateCalls[0].size).toBe('1024x1024');
  });

  it("routes provider: 'flux-2-pro' to the flux-2-pro client", async () => {
    await HANDLERS.generate_image(
      { prompt: 'misty diner', provider: 'flux-2-pro' },
      { projectId });
    expect(falFlux2ProCalls).toHaveLength(1);
    expect(falNanoBananaProCalls).toHaveLength(0);
    expect(uploads[0].generatedBy).toBe('fal-ai/flux-2-pro');
  });

  it("routes provider: 'flux-pro-kontext' to the kontext client", async () => {
    await HANDLERS.generate_image(
      { prompt: 'misty diner', provider: 'flux-pro-kontext' },
      { projectId });
    expect(falKontextCalls).toHaveLength(1);
    expect(falNanoBananaProCalls).toHaveLength(0);
    expect(uploads[0].generatedBy).toBe('fal-ai/flux-pro/kontext');
  });

  it("returns a friendly error when provider: 'openai' but OPENAI_API_KEY is unset", async () => {
    mockConfig.openai = { apiKey: null, imageTimeoutMs: 600_000 };

    const out = await HANDLERS.generate_image(
      { prompt: 'anything', provider: 'openai' },
      { projectId });
    expect(out).toMatch(/OpenAI is not configured/);
    expect(openaiGenerateCalls).toHaveLength(0);
    expect(openaiEditCalls).toHaveLength(0);
    expect(falNanoBananaProCalls).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it('returns a friendly error when default provider but FAL is unconfigured', async () => {
    falConfigured.mockReturnValue(false);

    const out = await HANDLERS.generate_image({ prompt: 'anything' }, null);
    expect(out).toMatch(/FAL is not configured/);
    expect(falNanoBananaProCalls).toHaveLength(0);
    expect(openaiGenerateCalls).toHaveLength(0);
  });

  it('auto-selects flux-2-pro when source_image_ids has 2+ inputs and no provider is set', async () => {
    const a = await seedLibraryImage();
    const b = await seedLibraryImage();

    await HANDLERS.generate_image(
      {
        prompt: 'mix these two together',
        source_image_ids: [a.toString(), b.toString()],
      },
      { projectId });

    expect(falFlux2ProCalls).toHaveLength(1);
    expect(falNanoBananaProCalls).toHaveLength(0);
    expect(falFlux2ProCalls[0].inputImages).toHaveLength(2);
    expect(uploads[0].generatedBy).toBe('fal-ai/flux-2-pro');
  });

  it('keeps nano-banana-pro as default when only one source_image_id is passed', async () => {
    const a = await seedLibraryImage();

    await HANDLERS.generate_image(
      {
        prompt: 'remix this',
        source_image_ids: [a.toString()],
      },
      { projectId });

    expect(falNanoBananaProCalls).toHaveLength(1);
    expect(falFlux2ProCalls).toHaveLength(0);
    expect(falNanoBananaProCalls[0].inputImages).toHaveLength(1);
  });

  it('honors an explicit provider even with multiple source_image_ids', async () => {
    const a = await seedLibraryImage();
    const b = await seedLibraryImage();

    await HANDLERS.generate_image(
      {
        prompt: 'combine these',
        provider: 'nano-banana-pro',
        source_image_ids: [a.toString(), b.toString()],
      },
      { projectId });

    expect(falNanoBananaProCalls).toHaveLength(1);
    expect(falFlux2ProCalls).toHaveLength(0);
    expect(falNanoBananaProCalls[0].inputImages).toHaveLength(2);
  });

  it('dedupes source ids across source_image_id and source_image_ids', async () => {
    const a = await seedLibraryImage();
    const b = await seedLibraryImage();

    await HANDLERS.generate_image(
      {
        prompt: 'blend',
        source_image_id: a.toString(),
        source_image_ids: [a.toString(), b.toString()],
      },
      { projectId });

    // a appears in both fields but should only feed one ref through.
    expect(falFlux2ProCalls).toHaveLength(1);
    expect(falFlux2ProCalls[0].inputImages).toHaveLength(2);
  });

  it('returns a friendly error when one source in the array is missing', async () => {
    const a = await seedLibraryImage();
    const ghost = new ObjectId().toString();

    const out = await HANDLERS.generate_image(
      {
        prompt: 'mix',
        source_image_ids: [a.toString(), ghost],
      },
      { projectId });

    expect(out).toMatch(/source image not found/);
    expect(falFlux2ProCalls).toHaveLength(0);
    expect(falNanoBananaProCalls).toHaveLength(0);
  });
});

describe('edit_image provider routing', () => {
  it("routes provider: 'openai' to the gpt-image-2 edit endpoint", async () => {
    const sourceId = await seedLibraryImage();

    const out = await HANDLERS.edit_image(
      {
        source_image_id: sourceId.toString(),
        prompt: 'add neon signage',
        replace_source: false,
        provider: 'openai',
      },
      { projectId, discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' });
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(falNanoBananaProCalls).toHaveLength(0);
    expect(openaiEditCalls).toHaveLength(1);
    expect(openaiEditCalls[0].prompt).toContain('neon signage');
    expect(openaiEditCalls[0].inputImages).toHaveLength(1);
    expect(openaiEditCalls[0].inputImages[0].contentType).toBe('image/png');

    expect(uploads[0].generatedBy).toBe('gpt-image-2');

    const tokenDocs = fakeDb.collection('token_usage')._docs;
    expect(tokenDocs).toHaveLength(1);
    expect(tokenDocs[0].kind).toBe('openai_image');
    expect(tokenDocs[0].model).toBe('gpt-image-2');
    expect(tokenDocs[0].tokens).toBe(530);
  });

  it('defaults to nano-banana-pro when provider is omitted', async () => {
    const sourceId = await seedLibraryImage();

    await HANDLERS.edit_image(
      {
        source_image_id: sourceId.toString(),
        prompt: 'add neon signage',
        replace_source: false,
      },
      { projectId });
    expect(falNanoBananaProCalls).toHaveLength(1);
    expect(openaiEditCalls).toHaveLength(0);
    // Default-edit on nano-banana-pro routes through the /edit endpoint since
    // the source image is passed as an input.
    expect(uploads[0].generatedBy).toBe('fal-ai/nano-banana-pro/edit');
  });

  it("returns a friendly error when provider: 'openai' but OPENAI_API_KEY is unset", async () => {
    mockConfig.openai = { apiKey: null, imageTimeoutMs: 600_000 };
    const sourceId = await seedLibraryImage();

    const out = await HANDLERS.edit_image(
      {
        source_image_id: sourceId.toString(),
        prompt: 'anything',
        replace_source: false,
        provider: 'openai',
      },
      { projectId });
    expect(out).toMatch(/OpenAI is not configured/);
    expect(openaiEditCalls).toHaveLength(0);
    expect(falNanoBananaProCalls).toHaveLength(0);
  });

  it('auto-selects flux-2-pro when additional_source_image_ids is non-empty and no provider is set', async () => {
    const primaryId = await seedLibraryImage();
    const extraId = await seedLibraryImage();

    await HANDLERS.edit_image(
      {
        source_image_id: primaryId.toString(),
        additional_source_image_ids: [extraId.toString()],
        prompt: 'put this outfit on him',
        replace_source: false,
      },
      { projectId });

    expect(falFlux2ProCalls).toHaveLength(1);
    expect(falNanoBananaProCalls).toHaveLength(0);
    // primary + 1 extra = 2 inputs.
    expect(falFlux2ProCalls[0].inputImages).toHaveLength(2);
    expect(uploads[0].generatedBy).toBe('fal-ai/flux-2-pro');
  });

  it('dedupes additional ids that duplicate the primary source', async () => {
    const primaryId = await seedLibraryImage();
    const extraId = await seedLibraryImage();

    await HANDLERS.edit_image(
      {
        source_image_id: primaryId.toString(),
        additional_source_image_ids: [primaryId.toString(), extraId.toString()],
        prompt: 'blend',
        replace_source: false,
      },
      { projectId });

    expect(falFlux2ProCalls).toHaveLength(1);
    // primary (counted once) + extraId = 2 distinct refs.
    expect(falFlux2ProCalls[0].inputImages).toHaveLength(2);
  });

  it('honors an explicit provider even when additional_source_image_ids triggers multi-input', async () => {
    const primaryId = await seedLibraryImage();
    const extraId = await seedLibraryImage();

    await HANDLERS.edit_image(
      {
        source_image_id: primaryId.toString(),
        additional_source_image_ids: [extraId.toString()],
        prompt: 'composite',
        replace_source: false,
        provider: 'nano-banana-pro',
      },
      { projectId });

    expect(falNanoBananaProCalls).toHaveLength(1);
    expect(falFlux2ProCalls).toHaveLength(0);
    expect(falNanoBananaProCalls[0].inputImages).toHaveLength(2);
  });
});
