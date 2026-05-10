// Provider-routing tests for generate_image / edit_image.
//
// Verifies that:
//   - Default (no provider) → Gemini (Nano Banana) path, records gemini_image
//     usage, stamps gemini-2.5-flash-image as generated_by.
//   - provider: 'openai' → OpenAI gpt-image-2 path, records openai_image
//     usage, stamps gpt-image-2 as generated_by, and routes to images.edits
//     when a source_image_id is present.
//   - provider: 'openai' with OPENAI_API_KEY unset → friendly error string,
//     no model call.
//   - The dispatch helper does NOT silently fall back: an unconfigured Gemini
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

const geminiCalls = [];
vi.mock('../src/gemini/client.js', () => ({
  generateImage: async (args) => {
    geminiCalls.push(args);
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 1290,
        totalTokenCount: 1300,
      },
    };
  },
  NANO_BANANA_MODEL: 'gemini-2.5-flash-image',
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
  uploadGeneratedImage: async ({ buffer, contentType, prompt, generatedBy, ownerType, ownerId }) => {
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
  gemini: { apiKey: 'fake-gemini-key', vertex: { project: null, location: null } },
  openai: { apiKey: 'fake-openai-key', imageTimeoutMs: 600_000 },
  discord: { movieChannelId: 'cX' },
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

beforeEach(() => {
  fakeDb.reset();
  fakeBucket.clear();
  uploads.length = 0;
  geminiCalls.length = 0;
  openaiGenerateCalls.length = 0;
  openaiEditCalls.length = 0;
  mockConfig.gemini = { apiKey: 'fake-gemini-key', vertex: { project: null, location: null } };
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
  it('defaults to gemini when provider is omitted', async () => {
    const out = await HANDLERS.generate_image(
      { prompt: 'a cathedral at dusk' },
      { discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' },
    );
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(geminiCalls).toHaveLength(1);
    expect(openaiGenerateCalls).toHaveLength(0);
    expect(uploads[0].generatedBy).toBe('gemini-2.5-flash-image');

    const tokenDocs = fakeDb.collection('token_usage')._docs;
    expect(tokenDocs).toHaveLength(1);
    expect(tokenDocs[0].kind).toBe('gemini_image');
    expect(tokenDocs[0].model).toBe('gemini-2.5-flash-image');
  });

  it("routes provider: 'openai' to gpt-image-2 generate endpoint", async () => {
    const out = await HANDLERS.generate_image(
      { prompt: 'a cathedral at dusk', provider: 'openai' },
      { discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' },
    );
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(geminiCalls).toHaveLength(0);
    expect(openaiGenerateCalls).toHaveLength(1);
    expect(openaiEditCalls).toHaveLength(0);
    expect(openaiGenerateCalls[0].prompt).toContain('cathedral at dusk');
    // Default aspect_ratio → DEFAULT_OPENAI_SIZE in dispatch helper.
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
      { discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' },
    );
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(openaiGenerateCalls).toHaveLength(0);
    expect(openaiEditCalls).toHaveLength(1);
    expect(openaiEditCalls[0].inputImage).toBeDefined();
    expect(openaiEditCalls[0].inputImage.contentType).toBe('image/png');
  });

  it('maps aspect_ratio to the closest gpt-image-2 size', async () => {
    await HANDLERS.generate_image(
      { prompt: 'wide shot', provider: 'openai', aspect_ratio: '9:16' },
      null,
    );
    expect(openaiGenerateCalls[0].size).toBe('1024x1536');

    openaiGenerateCalls.length = 0;
    await HANDLERS.generate_image(
      { prompt: 'square', provider: 'openai', aspect_ratio: '1:1' },
      null,
    );
    expect(openaiGenerateCalls[0].size).toBe('1024x1024');
  });

  it("returns a friendly error when provider: 'openai' but OPENAI_API_KEY is unset", async () => {
    mockConfig.openai = { apiKey: null, imageTimeoutMs: 600_000 };

    const out = await HANDLERS.generate_image(
      { prompt: 'anything', provider: 'openai' },
      null,
    );
    expect(out).toMatch(/OpenAI is not configured/);
    expect(openaiGenerateCalls).toHaveLength(0);
    expect(openaiEditCalls).toHaveLength(0);
    expect(geminiCalls).toHaveLength(0); // does NOT silently fall back to Gemini
    expect(uploads).toHaveLength(0);
  });

  it('returns a friendly error when default provider but Gemini is unconfigured', async () => {
    mockConfig.gemini = { apiKey: null, vertex: { project: null, location: null } };

    const out = await HANDLERS.generate_image({ prompt: 'anything' }, null);
    expect(out).toMatch(/Gemini is not configured/);
    expect(geminiCalls).toHaveLength(0);
    expect(openaiGenerateCalls).toHaveLength(0); // does NOT silently fall back to OpenAI
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
      { discordUser: { id: 'u1', displayName: 'U1' }, channelId: 'c1' },
    );
    expect(out).toMatch(/^__IMAGE_PATH__:/);
    expect(geminiCalls).toHaveLength(0);
    expect(openaiEditCalls).toHaveLength(1);
    expect(openaiEditCalls[0].prompt).toContain('neon signage');
    expect(openaiEditCalls[0].inputImage.contentType).toBe('image/png');

    expect(uploads[0].generatedBy).toBe('gpt-image-2');

    const tokenDocs = fakeDb.collection('token_usage')._docs;
    expect(tokenDocs).toHaveLength(1);
    expect(tokenDocs[0].kind).toBe('openai_image');
    expect(tokenDocs[0].model).toBe('gpt-image-2');
    expect(tokenDocs[0].tokens).toBe(530);
  });

  it('defaults to gemini when provider is omitted', async () => {
    const sourceId = await seedLibraryImage();

    await HANDLERS.edit_image(
      {
        source_image_id: sourceId.toString(),
        prompt: 'add neon signage',
        replace_source: false,
      },
      null,
    );
    expect(geminiCalls).toHaveLength(1);
    expect(openaiEditCalls).toHaveLength(0);
    expect(uploads[0].generatedBy).toBe('gemini-2.5-flash-image');
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
      null,
    );
    expect(out).toMatch(/OpenAI is not configured/);
    expect(openaiEditCalls).toHaveLength(0);
    expect(geminiCalls).toHaveLength(0);
  });
});
