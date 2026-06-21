import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
});

describe('beat critique schema backfill', () => {
  it('defaults critique and previous_body on a new beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const fresh = await Plots.getBeat(projectId, beat._id.toString());
    expect(fresh.critique).toBeNull();
    expect(fresh.previous_body).toBeNull();
  });

  it('backfills legacy beats missing the fields', async () => {
    // Simulate a legacy plot doc with a beat lacking the new fields.
    await fakeDb.collection('plots').insertOne({
      _id: 'legacy', project_id: projectId, title: '', synopsis: '',
      beats: [{ order: 1, name: 'Old', body: 'x' }], current_beat_id: null, updated_at: new Date(),
    });
    const beats = await Plots.listBeats(projectId);
    expect(beats[0].critique).toBeNull();
    expect(beats[0].previous_body).toBeNull();
  });
});
