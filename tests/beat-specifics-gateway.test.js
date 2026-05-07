import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Plots = await import('../src/mongo/plots.js');
const {
  setEntityFieldMarkdown,
  updateBeatViaGateway,
  setBeatSceneSheetImageViaGateway,
} = await import('../src/web/gateway.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('gateway — beat specifics text-field fallback (no Hocuspocus)', () => {
  it('setEntityFieldMarkdown writes specifics.<key> through updateBeat', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    await setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: b._id.toString(),
      field: 'specifics.set_dressing',
      markdown: 'red vinyl booths, neon sign',
    });
    const updated = await Plots.getBeat(b._id.toString());
    expect(updated.specifics.set_dressing).toBe('red vinyl booths, neon sign');
  });

  it('updateBeatViaGateway accepts patch.specifics object', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const result = await updateBeatViaGateway(b._id.toString(), {
      specifics: {
        scene_type: 'interior',
        focal_points: 'corner booth, jukebox',
      },
    });
    expect(result.specifics.scene_type).toBe('interior');
    expect(result.specifics.focal_points).toBe('corner booth, jukebox');
  });

  it('updateBeatViaGateway accepts dotted specifics keys', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const result = await updateBeatViaGateway(b._id.toString(), {
      'specifics.continuity_locks': 'preserve broken jukebox; preserve north-side burn',
    });
    expect(result.specifics.continuity_locks).toBe(
      'preserve broken jukebox; preserve north-side burn',
    );
  });
});

describe('gateway — setBeatSceneSheetImageViaGateway', () => {
  it('sets and clears scene_sheet_image_id via Mongo', async () => {
    const b = await Plots.createBeat({ name: 'Diner', desc: 'd' });
    const imageId = new ObjectId();

    await setBeatSceneSheetImageViaGateway({
      beatId: b._id.toString(),
      imageId: imageId.toString(),
    });
    let updated = await Plots.getBeat(b._id.toString());
    expect(updated.scene_sheet_image_id.equals(imageId)).toBe(true);

    await setBeatSceneSheetImageViaGateway({
      beatId: b._id.toString(),
      imageId: null,
    });
    updated = await Plots.getBeat(b._id.toString());
    expect(updated.scene_sheet_image_id).toBeNull();
  });

  it('throws when the beat does not exist', async () => {
    await expect(
      setBeatSceneSheetImageViaGateway({
        beatId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        imageId: new ObjectId().toString(),
      }),
    ).rejects.toThrow(/Beat not found/);
  });
});
