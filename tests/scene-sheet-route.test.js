import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const uploadedImages = [];
const deletedImages = [];

vi.mock('../src/mongo/images.js', () => ({
  uploadGeneratedImage: async ({ buffer, contentType, prompt, ownerType, ownerId, filename }) => {
    const _id = new ObjectId();
    uploadedImages.push({ _id, buffer, contentType, prompt, ownerType, ownerId, filename });
    return {
      _id,
      filename,
      content_type: contentType,
      size: buffer.length,
      uploaded_at: new Date(),
    };
  },
  deleteImage: async (id) => {
    deletedImages.push(id?.toString?.() || String(id));
  },
  readImageBuffer: async () => null,
}));

vi.mock('../src/config.js', async () => {
  const real = await vi.importActual('../src/config.js');
  return {
    ...real,
    config: {
      ...real.config,
      openai: { apiKey: 'test-openai-key' },
    },
  };
});

const Plots = await import('../src/mongo/plots.js');
const Sheet = await import('../src/web/beatSceneSheet.js');

beforeEach(() => {
  fakeDb.reset();
  uploadedImages.length = 0;
  deletedImages.length = 0;
  Sheet._resetGeneratorForTests();
});

describe('generateSceneSheetForBeat', () => {
  it('builds a prompt from beat specifics, uploads the result, and updates the beat', async () => {
    const b = await Plots.createBeat({ name: 'Diner Showdown', desc: 'tense argument' });
    await Plots.updateBeat(b._id.toString(), {
      specifics: {
        scene_type: 'interior',
        time_period: 'dusk',
        set_dressing: 'red vinyl booths, neon sign, jukebox in the corner',
      },
    });

    let receivedPrompt = null;
    let receivedSize = null;
    let receivedQuality = null;
    Sheet._setGeneratorForTests(async ({ prompt, size, quality }) => {
      receivedPrompt = prompt;
      receivedSize = size;
      receivedQuality = quality;
      return { buffer: TINY_PNG, contentType: 'image/png', model: 'gpt-image-2', latencyMs: 12 };
    });

    const result = await Sheet.generateSceneSheetForBeat({
      beatId: b._id.toString(),
      quality: 'low',
    });

    expect(receivedPrompt).toContain('UE5 production-grade scene reference sheet');
    expect(receivedPrompt).toContain('SCENE TYPE:\ninterior');
    expect(receivedPrompt).toContain('TIME / PERIOD:\ndusk');
    expect(receivedPrompt).toContain('SET DRESSING / LAYOUT:\nred vinyl booths');
    expect(receivedPrompt).toContain('REQUIRED VIEWS:');
    expect(receivedPrompt).toContain('SCENE NAME: Diner Showdown');
    expect(receivedSize).toBe('1536x1024');
    expect(receivedQuality).toBe('low');

    expect(uploadedImages).toHaveLength(1);
    expect(uploadedImages[0].ownerType).toBe('beat');
    expect(String(uploadedImages[0].ownerId)).toBe(b._id.toString());

    const updated = await Plots.getBeat(b._id.toString());
    expect(updated.scene_sheet_image_id).toBeDefined();
    expect(updated.scene_sheet_image_id.toString()).toBe(result.image_id);
    expect(deletedImages).toEqual([]);
  });

  it('deletes the previous sheet image on regeneration', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const previousId = new ObjectId();
    await Plots.updateBeat(b._id.toString(), {
      scene_sheet_image_id: previousId.toString(),
    });

    Sheet._setGeneratorForTests(async () => ({
      buffer: TINY_PNG,
      contentType: 'image/png',
      model: 'gpt-image-2',
      latencyMs: 5,
    }));

    const result = await Sheet.generateSceneSheetForBeat({
      beatId: b._id.toString(),
      quality: 'auto',
    });

    expect(deletedImages).toEqual([previousId.toString()]);

    const updated = await Plots.getBeat(b._id.toString());
    expect(updated.scene_sheet_image_id.toString()).toBe(result.image_id);
    expect(updated.scene_sheet_image_id.toString()).not.toBe(previousId.toString());
  });

  it('throws status=404 when the beat does not exist', async () => {
    Sheet._setGeneratorForTests(async () => ({
      buffer: TINY_PNG,
      contentType: 'image/png',
      model: 'gpt-image-2',
    }));
    let err;
    try {
      await Sheet.generateSceneSheetForBeat({
        beatId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        quality: 'auto',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});
