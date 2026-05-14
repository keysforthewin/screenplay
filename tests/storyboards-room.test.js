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
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({}));

const { resolveRoom, buildRoomName } = await import('../src/web/roomRegistry.js');
const Storyboards = await import('../src/mongo/storyboards.js');

beforeEach(() => {
  fakeDb.reset();
});

const beatA = new ObjectId();

describe('storyboards room', () => {
  it('emits text_prompt, summary, and per-frame prompt fragments per storyboard', async () => {
    const a = await Storyboards.createStoryboard({
      beatId: beatA,
      textPrompt: 'Wide on the diner.',
      summary: 'Diner exterior at dusk.',
    });
    const b = await Storyboards.createStoryboard({
      beatId: beatA,
      textPrompt: 'Close on Alice.',
      summary: 'Alice notices the stranger.',
    });
    await Storyboards.updateStoryboard(a._id, {
      start_frame_prompt: 'Wide on the doorway.',
      end_frame_prompt: 'Wide on the booth.',
    });

    const desc = await resolveRoom(buildRoomName('storyboards', beatA.toString()));
    expect(desc.type).toBe('storyboards');
    const aId = a._id.toString();
    const bId = b._id.toString();
    expect(desc.fields).toEqual(
      expect.arrayContaining([
        `item:${aId}:text_prompt`,
        `item:${aId}:summary`,
        `item:${aId}:start_frame_prompt`,
        `item:${aId}:end_frame_prompt`,
        `item:${bId}:text_prompt`,
        `item:${bId}:summary`,
        `item:${bId}:start_frame_prompt`,
        `item:${bId}:end_frame_prompt`,
      ]),
    );
    expect(desc.seed[`item:${aId}:start_frame_prompt`]).toBe('Wide on the doorway.');
    expect(desc.seed[`item:${aId}:end_frame_prompt`]).toBe('Wide on the booth.');
    expect(desc.seed[`item:${bId}:start_frame_prompt`]).toBe('');
  });

  it('persistFields writes text_prompt, summary, and frame prompts back to Mongo', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const id = sb._id.toString();

    const desc = await resolveRoom(buildRoomName('storyboards', beatA.toString()));
    const result = await desc.persistFields({
      [`item:${id}:text_prompt`]: 'New prompt body.',
      [`item:${id}:summary`]: 'New one-liner.',
      [`item:${id}:start_frame_prompt`]: 'New start prompt.',
      [`item:${id}:end_frame_prompt`]: 'New end prompt.',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(
      expect.arrayContaining([
        `item:${id}:text_prompt`,
        `item:${id}:summary`,
        `item:${id}:start_frame_prompt`,
        `item:${id}:end_frame_prompt`,
      ]),
    );

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.text_prompt).toBe('New prompt body.');
    expect(fresh.summary).toBe('New one-liner.');
    expect(fresh.start_frame_prompt).toBe('New start prompt.');
    expect(fresh.end_frame_prompt).toBe('New end prompt.');
  });

  it('persistFields no-ops when nothing changed', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId: beatA,
      textPrompt: 'Same.',
      summary: 'Same summary.',
    });
    const id = sb._id.toString();

    const desc = await resolveRoom(buildRoomName('storyboards', beatA.toString()));
    const result = await desc.persistFields({
      [`item:${id}:text_prompt`]: 'Same.',
      [`item:${id}:summary`]: 'Same summary.',
    });
    expect(result.changed).toBe(false);
  });

  it('persistFields ignores unknown field names', async () => {
    const sb = await Storyboards.createStoryboard({ beatId: beatA });
    const id = sb._id.toString();

    const desc = await resolveRoom(buildRoomName('storyboards', beatA.toString()));
    const result = await desc.persistFields({
      [`item:${id}:not_a_field`]: 'should be ignored',
    });
    expect(result.changed).toBe(false);
  });
});
