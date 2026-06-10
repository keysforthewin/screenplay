// Verifies the storyboard gateway flows in fallback mode (no Hocuspocus).
// Mirrors web-gateway-fallback.test.js style. Frame pool model: frames are
// addressed by their stable per-frame `_id`, not a start/end role.

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

function frame(sb, frameId) {
  return sb.frames.find((f) => f._id.toString() === String(frameId));
}

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
    expect(sb.frames).toEqual([]);
  });

  it('setStoryboardTextPromptViaGateway writes the prompt via fallback', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await Gateway.setStoryboardTextPromptViaGateway({
      storyboardId: sb._id,
      text: 'Wide shot of the diner interior.',
    });
    const fresh = await Storyboards.getStoryboard(undefined, sb._id);
    expect(fresh.text_prompt).toBe('Wide shot of the diner interior.');
  });

  it('setStoryboardSummaryViaGateway writes the summary via fallback', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    await Gateway.setStoryboardSummaryViaGateway({
      storyboardId: sb._id,
      text: 'Diner exterior, dusk.',
    });
    const fresh = await Storyboards.getStoryboard(undefined, sb._id);
    expect(fresh.summary).toBe('Diner exterior, dusk.');
  });

  describe('frame pool', () => {
    it('addStoryboardFrameViaGateway appends a frame and returns its id', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const img = new ObjectId();
      const { storyboard, frameId } = await Gateway.addStoryboardFrameViaGateway({
        storyboardId: sb._id,
        imageId: img,
        prompt: 'Wide on the doorway.',
      });
      expect(storyboard.frames).toHaveLength(1);
      const f = frame(storyboard, frameId);
      expect(f.image_id.toString()).toBe(img.toString());
      expect(f.prompt).toBe('Wide on the doorway.');
    });

    it('removeStoryboardFrameViaGateway drops the frame', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({
        storyboardId: sb._id,
      });
      const out = await Gateway.removeStoryboardFrameViaGateway({
        storyboardId: sb._id,
        frameId,
      });
      expect(out.frames).toHaveLength(0);
    });

    it('reorderStoryboardFramesViaGateway reorders the pool', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const a = (await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id, prompt: 'a' })).frameId;
      const b = (await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id, prompt: 'b' })).frameId;
      const out = await Gateway.reorderStoryboardFramesViaGateway({
        storyboardId: sb._id,
        orderedFrameIds: [b.toString(), a.toString()],
      });
      expect(out.frames.map((f) => f.prompt)).toEqual(['b', 'a']);
    });

    it('setStoryboardFrameImageViaGateway sets and clears a frame image', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id });
      const img = new ObjectId();
      let out = await Gateway.setStoryboardFrameImageViaGateway({
        storyboardId: sb._id,
        frameId,
        imageId: img,
      });
      expect(frame(out, frameId).image_id.toString()).toBe(img.toString());
      out = await Gateway.setStoryboardFrameImageViaGateway({
        storyboardId: sb._id,
        frameId,
        imageId: null,
      });
      expect(frame(out, frameId).image_id).toBe(null);
    });
  });

  describe('per-frame references', () => {
    it('add/remove per-frame reference image round-trips', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id });
      const r = new ObjectId();
      let next = await Gateway.addStoryboardFrameReferenceImageViaGateway({
        storyboardId: sb._id,
        frameId,
        imageId: r,
      });
      expect(frame(next, frameId).reference_ids).toHaveLength(1);
      next = await Gateway.removeStoryboardFrameReferenceImageViaGateway({
        storyboardId: sb._id,
        frameId,
        imageId: r,
      });
      expect(frame(next, frameId).reference_ids).toHaveLength(0);
    });

    it('setStoryboardFrameReferenceImagesViaGateway mode=append dedupes vs existing', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id });
      const r1 = new ObjectId();
      const r2 = new ObjectId();
      await Gateway.addStoryboardFrameReferenceImageViaGateway({
        storyboardId: sb._id,
        frameId,
        imageId: r1,
      });
      const next = await Gateway.setStoryboardFrameReferenceImagesViaGateway({
        storyboardId: sb._id,
        frameId,
        imageIds: [r1.toString(), r2.toString()],
        mode: 'append',
      });
      expect(frame(next, frameId).reference_ids.map((x) => x.toString())).toEqual([
        r1.toString(),
        r2.toString(),
      ]);
    });

    it('setStoryboardFrameReferenceImagesViaGateway mode=replace overwrites the list', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id });
      const r1 = new ObjectId();
      const r3 = new ObjectId();
      await Gateway.addStoryboardFrameReferenceImageViaGateway({
        storyboardId: sb._id,
        frameId,
        imageId: r1,
      });
      const next = await Gateway.setStoryboardFrameReferenceImagesViaGateway({
        storyboardId: sb._id,
        frameId,
        imageIds: [r3.toString()],
        mode: 'replace',
      });
      expect(frame(next, frameId).reference_ids).toHaveLength(1);
      expect(frame(next, frameId).reference_ids[0].toString()).toBe(r3.toString());
    });

    it('setStoryboardFrameReferenceImagesViaGateway rejects an invalid mode', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id });
      await expect(
        Gateway.setStoryboardFrameReferenceImagesViaGateway({
          storyboardId: sb._id,
          frameId,
          imageIds: [new ObjectId().toString()],
          mode: 'wat',
        }),
      ).rejects.toThrow(/invalid mode/);
    });
  });

  it('setStoryboardFramePromptViaGateway persists a frame prompt', async () => {
    const beat = await makeBeat();
    const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
    const { frameId } = await Gateway.addStoryboardFrameViaGateway({ storyboardId: sb._id });
    await Gateway.setStoryboardFramePromptViaGateway({
      storyboardId: sb._id,
      frameId,
      text: 'Wide on the diner doorway.',
    });
    const fresh = await Storyboards.getStoryboard(undefined, sb._id);
    expect(frame(fresh, frameId).prompt).toBe('Wide on the diner doorway.');
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

  describe('frame edit/undo rotation', () => {
    it('setStoryboardFrameEditResultViaGateway rotates current→previous', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const initial = new ObjectId();
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({
        storyboardId: sb._id,
        imageId: initial,
      });
      const next = new ObjectId();
      const updated = await Gateway.setStoryboardFrameEditResultViaGateway({
        storyboardId: sb._id,
        frameId,
        newImageId: next,
        editPrompt: 'add a red hat',
      });
      const f = frame(updated, frameId);
      expect(f.image_id.toString()).toBe(next.toString());
      expect(f.previous_image_id.toString()).toBe(initial.toString());
      expect(f.last_edit_prompt).toBe('add a red hat');
    });

    it('undoStoryboardFrameEditViaGateway restores the previous frame', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const initial = new ObjectId();
      const edited = new ObjectId();
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({
        storyboardId: sb._id,
        imageId: initial,
      });
      await Gateway.setStoryboardFrameEditResultViaGateway({
        storyboardId: sb._id,
        frameId,
        newImageId: edited,
        editPrompt: 'tweak',
      });
      const after = await Gateway.undoStoryboardFrameEditViaGateway({
        storyboardId: sb._id,
        frameId,
      });
      const f = frame(after, frameId);
      expect(f.image_id.toString()).toBe(initial.toString());
      expect(f.previous_image_id).toBe(null);
      expect(f.last_edit_prompt).toBe('');
    });

    it('undoStoryboardFrameEditViaGateway throws when nothing to undo', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({
        storyboardId: sb._id,
        imageId: new ObjectId(),
      });
      await expect(
        Gateway.undoStoryboardFrameEditViaGateway({
          storyboardId: sb._id,
          frameId,
        }),
      ).rejects.toThrow(/no previous image stored/);
    });

    it('rotating throws when the frame has no current image', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      const { frameId } = await Gateway.addStoryboardFrameViaGateway({
        storyboardId: sb._id,
      });
      await expect(
        Gateway.setStoryboardFrameEditResultViaGateway({
          storyboardId: sb._id,
          frameId,
          newImageId: new ObjectId(),
          editPrompt: 'x',
        }),
      ).rejects.toThrow(/no current image to rotate/);
    });
  });

  describe('reverse_in_post (reveal-shot flag)', () => {
    it('defaults to false on a freshly created storyboard', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      expect(sb.reverse_in_post).toBe(false);
    });

    it('round-trips reverseInPost: true through createStoryboardViaGateway', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({
        beatId: beat._id,
        reverseInPost: true,
      });
      expect(sb.reverse_in_post).toBe(true);
      const fresh = await Storyboards.getStoryboard(undefined, sb._id);
      expect(fresh.reverse_in_post).toBe(true);
    });

    it('updateStoryboard can toggle reverse_in_post on and off', async () => {
      const beat = await makeBeat();
      const sb = await Gateway.createStoryboardViaGateway({ beatId: beat._id });
      let next = await Storyboards.updateStoryboard(undefined, sb._id, { reverse_in_post: true });
      expect(next.reverse_in_post).toBe(true);
      next = await Storyboards.updateStoryboard(undefined, sb._id, { reverse_in_post: false });
      expect(next.reverse_in_post).toBe(false);
    });
  });
});
