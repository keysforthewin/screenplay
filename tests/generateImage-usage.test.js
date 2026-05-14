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

vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: async () => ({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    contentType: 'image/png',
    model: 'fal-ai/nano-banana-pro',
  }),
  generateFlux2ProImage: async () => ({ buffer: Buffer.from([0x89]), contentType: 'image/png', model: 'fal-ai/flux-2-pro' }),
  generateFluxKontextImage: async () => ({ buffer: Buffer.from([0x89]), contentType: 'image/png', model: 'fal-ai/flux-pro/kontext' }),
  NANO_BANANA_PRO_GENERATE_MODEL: 'fal-ai/nano-banana-pro',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
}));
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => true,
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
      fal: { ...real.config.fal, apiKey: 'fake-fal-key' },
    },
  };
});

const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => fakeDb.reset());

describe('generate_image records FAL token usage', () => {
  it('writes one fal_image doc keyed to the calling user', async () => {
    const result = await HANDLERS.generate_image(
      { prompt: 'a screenplay-style still of a cathedral at dusk' },
      { discordUser: { id: 'caller-id', displayName: 'Caller' }, channelId: 'c1' },
    );
    expect(typeof result).toBe('string');

    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.kind).toBe('fal_image');
    expect(doc.discord_user_id).toBe('caller-id');
    expect(doc.discord_user_display_name).toBe('Caller');
    expect(doc.model).toBe('fal-ai/nano-banana-pro');
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
