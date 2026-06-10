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

const generateCalls = [];
vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: async ({ prompt, inputImages }) => {
    const inputs = inputImages || [];
    generateCalls.push({
      prompt,
      hasInput: inputs.length > 0,
      inputBytes: inputs[0]?.buffer?.length,
    });
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      model: inputs.length > 0 ? 'fal-ai/nano-banana-pro/edit' : 'fal-ai/nano-banana-pro',
    };
  },
  generateFlux2ProImage: async () => ({ buffer: Buffer.from([0x89]), contentType: 'image/png', model: 'fal-ai/flux-2-pro' }),
  generateFluxKontextImage: async () => ({ buffer: Buffer.from([0x89]), contentType: 'image/png', model: 'fal-ai/flux-pro/kontext' }),
  NANO_BANANA_PRO_GENERATE_MODEL: 'fal-ai/nano-banana-pro',
  FLUX_2_PRO_MODEL: 'fal-ai/flux-2-pro',
  FLUX_KONTEXT_MODEL: 'fal-ai/flux-pro/kontext',
}));
vi.mock('../src/fal/client.js', () => ({
  isConfigured: () => true,
}));

const visionSeedCalls = [];
vi.mock('../src/web/libraryVisionWorker.js', () => ({
  kickoffLibraryVisionSeed: (id, buf, ct) => {
    visionSeedCalls.push({ id: String(id), bytes: buf?.length, ct });
  },
}));

const uploadCalls = [];
vi.mock('../src/mongo/images.js', async () => {
  const real = await vi.importActual('../src/mongo/images.js');
  return {
    ...real,
    uploadGeneratedImage: async (_projectId, args) => {
      uploadCalls.push({ ownerType: args.ownerType, ownerId: args.ownerId });
      return {
        _id: new ObjectId(),
        filename: 'gen.png',
        content_type: 'image/png',
        size: 4,
        uploaded_at: new Date(),
      };
    },
    streamImageToTmp: async (id) => ({ path: `/tmp/${String(id)}.png` }),
    readImageBuffer: async (id) => ({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]),
      file: {
        _id: id instanceof ObjectId ? id : new ObjectId(String(id)),
        contentType: 'image/png',
        metadata: { owner_type: null, owner_id: null },
      },
    }),
  };
});

vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    config: {
      ...real.config,
      gemini: { apiKey: 'fake-key', vertex: { project: null, location: null } },
      fal: {
        ...real.config.fal,
        apiKey: 'fake-fal-key',
      },
      discord: { ...real.config.discord, movieChannelId: 'cX' },
    },
  };
});

const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
  generateCalls.length = 0;
  uploadCalls.length = 0;
  visionSeedCalls.length = 0;
});

describe('generate_image with source_image_id', () => {
  it('passes the source image bytes to the gemini client as inputImage', async () => {
    const out = await HANDLERS.generate_image({
      prompt: 'lower the sun a bit',
      source_image_id: new ObjectId().toString(),
    });
    expect(out).toMatch(/saved to library/);
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0].hasInput).toBe(true);
    expect(generateCalls[0].inputBytes).toBeGreaterThan(0);
  });

  it('library-bound generations kick off the vision seed', async () => {
    await HANDLERS.generate_image({ prompt: 'a leopard at dusk' });
    expect(visionSeedCalls).toHaveLength(1);
    expect(visionSeedCalls[0].ct).toBe('image/png');
  });

  it('does not kick off the vision seed when the image is attached to a beat', async () => {
    const Plots = await import('../src/mongo/plots.js');
    const beat = await Plots.createBeat({ name: 'Diner', desc: 'tense' });
    await HANDLERS.generate_image({
      prompt: 'establishing shot',
      attach_to_beat: 'Diner',
    });
    expect(uploadCalls[0].ownerType).toBe('beat');
    expect(uploadCalls[0].ownerId.equals(beat._id)).toBe(true);
    expect(visionSeedCalls).toHaveLength(0);
  });
});
