import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('../src/gemini/client.js', () => ({
  generateImage: async () => ({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    contentType: 'image/png',
    usageMetadata: {
      promptTokenCount: 25,
      candidatesTokenCount: 1290,
      totalTokenCount: 1315,
    },
  }),
  NANO_BANANA_MODEL: 'gemini-2.5-flash-image',
}));

vi.mock('../src/mongo/plots.js', () => ({
  getCurrentBeat: async () => null,
  pushBeatImage: async () => {},
}));

vi.mock('../src/mongo/images.js', () => ({
  uploadGeneratedImage: async () => ({
    _id: { toString: () => 'fake-image-id' },
    filename: 'gen.png',
    content_type: 'image/png',
    size: 4,
    uploaded_at: new Date(),
  }),
  streamImageToTmp: async () => ({ path: '/tmp/fake-image.png' }),
}));

vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    config: {
      ...real.config,
      gemini: { apiKey: 'fake-key', vertex: { project: null, location: null } },
    },
  };
});

const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => fakeDb.reset());

describe('generate_image records Gemini token usage', () => {
  it('writes one gemini_image doc keyed to the calling user', async () => {
    const result = await HANDLERS.generate_image(
      { prompt: 'a screenplay-style still of a cathedral at dusk' },
      { discordUser: { id: 'caller-id', displayName: 'Caller' }, channelId: 'c1' },
    );
    expect(typeof result).toBe('string');

    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.kind).toBe('gemini_image');
    expect(doc.discord_user_id).toBe('caller-id');
    expect(doc.discord_user_display_name).toBe('Caller');
    expect(doc.tokens).toBe(1315);
    expect(doc.meta.prompt_token_count).toBe(25);
    expect(doc.meta.candidates_token_count).toBe(1290);
    expect(doc.model).toBe('gemini-2.5-flash-image');
  });

  it('does not crash when context is null', async () => {
    const result = await HANDLERS.generate_image(
      { prompt: 'orphan generation' },
      null,
    );
    expect(typeof result).toBe('string');
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].discord_user_id).toBeNull();
  });
});
