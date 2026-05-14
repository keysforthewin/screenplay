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

  it.each(['start_frame', 'end_frame'])(
    'add/remove per-frame reference image round-trips for %s',
    async (role) => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const field =
        role === 'start_frame'
          ? 'start_frame_reference_ids'
          : 'end_frame_reference_ids';
      const r = new ObjectId();
      let next = await Gateway.addStoryboardFrameReferenceImageViaGateway({
        storyboardId: sb._id,
        role,
        imageId: r,
      });
      expect(next[field]).toHaveLength(1);
      next = await Gateway.removeStoryboardFrameReferenceImageViaGateway({
        storyboardId: sb._id,
        role,
        imageId: r,
      });
      expect(next[field]).toHaveLength(0);
    },
  );

  it('setStoryboardFrameReferenceImagesViaGateway mode=append dedupes vs existing', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    await Gateway.addStoryboardFrameReferenceImageViaGateway({
      storyboardId: sb._id,
      role: 'start_frame',
      imageId: r1,
    });
    const next = await Gateway.setStoryboardFrameReferenceImagesViaGateway({
      storyboardId: sb._id,
      role: 'start_frame',
      imageIds: [r1.toString(), r2.toString()],
      mode: 'append',
    });
    expect(next.start_frame_reference_ids).toHaveLength(2);
    expect(next.start_frame_reference_ids.map((x) => x.toString())).toEqual([
      r1.toString(),
      r2.toString(),
    ]);
  });

  it('setStoryboardFrameReferenceImagesViaGateway mode=replace overwrites the list', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const r1 = new ObjectId();
    const r3 = new ObjectId();
    await Gateway.addStoryboardFrameReferenceImageViaGateway({
      storyboardId: sb._id,
      role: 'end_frame',
      imageId: r1,
    });
    const next = await Gateway.setStoryboardFrameReferenceImagesViaGateway({
      storyboardId: sb._id,
      role: 'end_frame',
      imageIds: [r3.toString()],
      mode: 'replace',
    });
    expect(next.end_frame_reference_ids).toHaveLength(1);
    expect(next.end_frame_reference_ids[0].toString()).toBe(r3.toString());
  });

  it('setStoryboardFrameReferenceImagesViaGateway rejects an invalid mode', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await expect(
      Gateway.setStoryboardFrameReferenceImagesViaGateway({
        storyboardId: sb._id,
        role: 'start_frame',
        imageIds: [new ObjectId().toString()],
        mode: 'wat',
      }),
    ).rejects.toThrow(/invalid mode/);
  });

  it('setStoryboardFrameReferenceImagesViaGateway rejects unknown roles', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await expect(
      Gateway.setStoryboardFrameReferenceImagesViaGateway({
        storyboardId: sb._id,
        role: 'character_sheet',
        imageIds: [],
        mode: 'replace',
      }),
    ).rejects.toThrow(/invalid frame role/);
  });

  it('setStoryboardFramePromptViaGateway persists each frame prompt', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await Gateway.setStoryboardFramePromptViaGateway({
      storyboardId: sb._id,
      role: 'start_frame',
      text: 'Wide on the diner doorway.',
    });
    await Gateway.setStoryboardFramePromptViaGateway({
      storyboardId: sb._id,
      role: 'end_frame',
      text: 'Door swings open.',
    });
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.start_frame_prompt).toBe('Wide on the diner doorway.');
    expect(fresh.end_frame_prompt).toBe('Door swings open.');
  });

  it('setStoryboardFramePromptViaGateway rejects unknown roles', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await expect(
      Gateway.setStoryboardFramePromptViaGateway({
        storyboardId: sb._id,
        role: 'character_sheet',
        text: 'x',
      }),
    ).rejects.toThrow(/invalid role/);
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

  it('setStoryboardSummaryViaGateway writes the summary via fallback', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await Gateway.setStoryboardSummaryViaGateway({
      storyboardId: sb._id,
      text: 'Diner exterior, dusk.',
    });
    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.summary).toBe('Diner exterior, dusk.');
  });
});
