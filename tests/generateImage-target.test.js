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

vi.mock('../src/fal/imageClient.js', () => ({
  generateNanoBananaProImage: async (args) => {
    const hasInput = (args.inputImages || []).length > 0;
    return {
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      model: hasInput ? 'fal-ai/nano-banana-pro/edit' : 'fal-ai/nano-banana-pro',
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

let lastUploadOwner = null;
vi.mock('../src/mongo/images.js', async () => {
  return {
    uploadGeneratedImage: async (_projectId, { ownerType, ownerId }) => {
      lastUploadOwner = { ownerType, ownerId };
      return {
        _id: new ObjectId(),
        filename: 'gen.png',
        content_type: 'image/png',
        size: 4,
        uploaded_at: new Date(),
      };
    },
    streamImageToTmp: async () => ({ path: '/tmp/fake.png' }),
  };
});

vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    config: {
      ...real.config,
      gemini: { apiKey: 'fake-key', vertex: { project: null, location: null } },
      fal: { ...real.config.fal, apiKey: 'fake-fal-key' },
      discord: { ...real.config.discord, movieChannelId: 'cX' },
    },
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  lastUploadOwner = null;
});

describe('generate_image targeted attachment', () => {
  it('falls back to library when no current beat and no targets', async () => {
    const out = await HANDLERS.generate_image({ prompt: 'leopard at dusk' }, { projectId });
    expect(out).toMatch(/saved to library/);
    expect(lastUploadOwner).toEqual({ ownerType: null, ownerId: null });
  });

  it('attaches to attach_to_character and pushes onto character.images[]', async () => {
    const c = await Characters.createCharacter({ projectId, name: 'Bronze Leopard' });

    const out = await HANDLERS.generate_image({
      prompt: 'a sleek bronze leopard portrait',
      attach_to_character: 'Bronze Leopard',
      set_as_main: true,
    }, { projectId });

    expect(out).toMatch(/attached to character "Bronze Leopard"/);
    expect(lastUploadOwner.ownerType).toBe('character');
    expect(lastUploadOwner.ownerId.equals(c._id)).toBe(true);

    const updated = await fakeDb.collection('characters').findOne({ _id: c._id });
    expect(updated.images).toHaveLength(1);
    expect(updated.main_image_id.equals(updated.images[0]._id)).toBe(true);
  });

  it('attaches to attach_to_beat regardless of current beat', async () => {
    const a = await Plots.createBeat({ projectId, name: 'Diner Showdown', desc: 'tense' });
    const b = await Plots.createBeat({ projectId, name: 'Rooftop', desc: 'storm' });
    await Plots.setCurrentBeat(projectId, b._id.toString());

    const out = await HANDLERS.generate_image({
      prompt: 'establishing shot',
      attach_to_beat: 'Diner Showdown',
    }, { projectId });

    expect(out).toMatch(/attached to beat "Diner Showdown"/);
    expect(lastUploadOwner.ownerType).toBe('beat');
    expect(lastUploadOwner.ownerId.equals(a._id)).toBe(true);

    const plot = await Plots.getPlot(projectId);
    const targetA = plot.beats.find((bb) => bb._id.equals(a._id));
    const targetB = plot.beats.find((bb) => bb._id.equals(b._id));
    expect(targetA.images).toHaveLength(1);
    expect(targetB.images || []).toHaveLength(0);
  });

  it('rejects when both attach_to_character and attach_to_beat are set', async () => {
    await Characters.createCharacter({ projectId, name: 'Bronze Leopard' });
    await Plots.createBeat({ projectId, name: 'Diner', desc: 'd' });

    const out = await HANDLERS.generate_image({
      prompt: 'x',
      attach_to_character: 'Bronze Leopard',
      attach_to_beat: 'Diner',
    }, { projectId });
    expect(out).toMatch(/at most one of attach_to_character or attach_to_beat/);
    expect(lastUploadOwner).toBeNull();
  });

  it('preserves existing behavior: defaults to current beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Cathedral', desc: 'dusk' });
    await Plots.setCurrentBeat(projectId, beat._id.toString());

    const out = await HANDLERS.generate_image({ prompt: 'cathedral at dusk' }, { projectId });
    expect(out).toMatch(/attached to beat "Cathedral"/);
    expect(lastUploadOwner.ownerType).toBe('beat');
    expect(lastUploadOwner.ownerId.equals(beat._id)).toBe(true);
  });

  it('respects attach_to_current_beat: false to override current-beat default', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'Cathedral', desc: 'dusk' });
    await Plots.setCurrentBeat(projectId, beat._id.toString());

    const out = await HANDLERS.generate_image({
      prompt: 'detached image',
      attach_to_current_beat: false,
    }, { projectId });
    expect(out).toMatch(/saved to library/);
    expect(lastUploadOwner).toEqual({ ownerType: null, ownerId: null });
  });

  it('throws when attach_to_character names an unknown character', async () => {
    await expect(
      HANDLERS.generate_image({
        prompt: 'x',
        attach_to_character: 'Ghost',
      }, { projectId }),
    ).rejects.toThrow(/Character not found/);
  });
});
