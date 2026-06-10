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

const { createProject } = await import('../src/mongo/projects.js');
const { resolveRoom, buildRoomName } = await import('../src/web/roomRegistry.js');
const Storyboards = await import('../src/mongo/storyboards.js');
const Projects = await import('../src/mongo/projects.js');

let beatA;
let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
  const p = await Projects.getDefaultProject();
  beatA = new ObjectId();
  // Insert a minimal plot doc so verifiedProjectIdForBeat resolves this beat.
  fakeDb.collection('plots')._docs.push({
    _id: 'main',
    project_id: p._id.toString(),
    beats: [{ _id: beatA, order: 1, name: '', desc: '', body: '' }],
  });
});

describe('storyboards room', () => {
  it('emits text_prompt, summary, and a prompt fragment per frame', async () => {
    const a = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      textPrompt: 'Wide on the diner.',
      summary: 'Diner exterior at dusk.',
    });
    const b = await Storyboards.createStoryboard({ projectId,
      beatId: beatA,
      textPrompt: 'Close on Alice.',
      summary: 'Alice notices the stranger.',
    });
    const { frameId: f1 } = await Storyboards.addFrame(a._id, {
      prompt: 'Wide on the doorway.',
    });
    const { frameId: f2 } = await Storyboards.addFrame(a._id, {
      prompt: 'Wide on the booth.',
    });

    const desc = await resolveRoom(buildRoomName('storyboards', beatA.toString()));
    expect(desc.type).toBe('storyboards');
    const aId = a._id.toString();
    const bId = b._id.toString();
    expect(desc.fields).toEqual(
      expect.arrayContaining([
        `item:${aId}:text_prompt`,
        `item:${aId}:summary`,
        `item:${aId}:frame:${f1}:prompt`,
        `item:${aId}:frame:${f2}:prompt`,
        `item:${bId}:text_prompt`,
        `item:${bId}:summary`,
      ]),
    );
    expect(desc.seed[`item:${aId}:frame:${f1}:prompt`]).toBe('Wide on the doorway.');
    expect(desc.seed[`item:${aId}:frame:${f2}:prompt`]).toBe('Wide on the booth.');
    // A storyboard with no frames contributes no frame fragments.
    expect(
      desc.fields.some((f) => f.startsWith(`item:${bId}:frame:`)),
    ).toBe(false);
  });

  it('persistFields writes text_prompt, summary, and frame prompts back to Mongo', async () => {
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const { frameId } = await Storyboards.addFrame(sb._id, {});
    const id = sb._id.toString();

    const desc = await resolveRoom(buildRoomName('storyboards', beatA.toString()));
    const result = await desc.persistFields({
      [`item:${id}:text_prompt`]: 'New prompt body.',
      [`item:${id}:summary`]: 'New one-liner.',
      [`item:${id}:frame:${frameId}:prompt`]: 'New frame prompt.',
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(
      expect.arrayContaining([
        `item:${id}:text_prompt`,
        `item:${id}:summary`,
        `item:${id}:frame:${frameId}:prompt`,
      ]),
    );

    const fresh = await Storyboards.getStoryboard(projectId, sb._id);
    expect(fresh.text_prompt).toBe('New prompt body.');
    expect(fresh.summary).toBe('New one-liner.');
    expect(fresh.frames.find((f) => f._id.equals(frameId)).prompt).toBe(
      'New frame prompt.',
    );
  });

  it('persistFields no-ops when nothing changed', async () => {
    const sb = await Storyboards.createStoryboard({ projectId,
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
    const sb = await Storyboards.createStoryboard({ projectId, beatId: beatA });
    const id = sb._id.toString();

    const desc = await resolveRoom(buildRoomName('storyboards', beatA.toString()));
    const result = await desc.persistFields({
      [`item:${id}:not_a_field`]: 'should be ignored',
    });
    expect(result.changed).toBe(false);
  });
});
