// Verifies the storyboard gateway flows in fallback mode (no Hocuspocus).
// Mirrors web-gateway-fallback.test.js style.

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

const Gateway = await import('../src/web/gateway.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Plots = await import('../src/mongo/plots.js');

describe('storyboard gateway (fallback)', () => {
  beforeEach(() => fakeDb.reset());

  async function makeBeat() {
    return Plots.createBeat({ name: 'Diner', desc: 'A diner scene.' });
  }

  it('createStoryboardViaGateway creates a row and returns it', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    expect(sb._id).toBeInstanceOf(ObjectId);
    expect(sb.beat_id.toString()).toBe(beat._id.toString());
    expect(sb.order).toBe(1);
  });

  it('setStoryboardTextPromptViaGateway writes the prompt via fallback', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await Gateway.setStoryboardTextPromptViaGateway({
      storyboardId: sb._id,
      text: 'Wide shot of the diner interior.',
    });
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.text_prompt).toBe('Wide shot of the diner interior.');
  });

  it('setStoryboardImageViaGateway sets and clears each role', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const imgId = new ObjectId();
    await Gateway.setStoryboardImageViaGateway({
      storyboardId: sb._id,
      role: 'start_frame',
      imageId: imgId,
    });
    let fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.start_frame_id.toString()).toBe(imgId.toString());

    await Gateway.setStoryboardImageViaGateway({
      storyboardId: sb._id,
      role: 'start_frame',
      imageId: null,
    });
    fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.start_frame_id).toBe(null);
  });

  it('setStoryboardImageViaGateway rejects unknown roles', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await expect(
      Gateway.setStoryboardImageViaGateway({
        storyboardId: sb._id,
        role: 'frame_extra',
        imageId: new ObjectId(),
      }),
    ).rejects.toThrow(/unknown storyboard role/);
  });

  it('addStoryboardReferenceImageViaGateway and removeStoryboardReferenceImageViaGateway round-trip', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const r = new ObjectId();
    let next = await Gateway.addStoryboardReferenceImageViaGateway({
      storyboardId: sb._id,
      imageId: r,
    });
    expect(next.reference_image_ids).toHaveLength(1);
    next = await Gateway.removeStoryboardReferenceImageViaGateway({
      storyboardId: sb._id,
      imageId: r,
    });
    expect(next.reference_image_ids).toHaveLength(0);
  });

  it('setStoryboardAudioViaGateway sets and clears the audio file id', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const audioId = new ObjectId();
    let next = await Gateway.setStoryboardAudioViaGateway({
      storyboardId: sb._id,
      audioFileId: audioId,
    });
    expect(next.audio_file_id.toString()).toBe(audioId.toString());
    next = await Gateway.setStoryboardAudioViaGateway({
      storyboardId: sb._id,
      audioFileId: null,
    });
    expect(next.audio_file_id).toBe(null);
  });

  it('reorderStoryboardsViaGateway recompacts orders to 1..N', async () => {
    const beat = await makeBeat();
    const a = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const b = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const c = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const reordered = await Gateway.reorderStoryboardsViaGateway({
      beatId: beat._id,
      orderedIds: [c._id.toString(), a._id.toString(), b._id.toString()],
    });
    expect(reordered.map((s) => s._id.toString())).toEqual([
      c._id.toString(),
      a._id.toString(),
      b._id.toString(),
    ]);
    expect(reordered.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('deleteStoryboardViaGateway removes the row and recompacts the rest', async () => {
    const beat = await makeBeat();
    const a = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const b = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const c = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await Gateway.deleteStoryboardViaGateway({ storyboardId: b._id });
    const list = await Storyboards.listStoryboards({ beatId: beat._id });
    expect(list.map((s) => s._id.toString())).toEqual([
      a._id.toString(),
      c._id.toString(),
    ]);
    expect(list.map((s) => s.order)).toEqual([1, 2]);
  });
});
