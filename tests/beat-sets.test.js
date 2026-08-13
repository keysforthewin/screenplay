import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Plots = await import('../src/mongo/plots.js');
const Projects = await import('../src/mongo/projects.js');

let p1;

beforeEach(async () => {
  fakeDb.reset();
  p1 = (await Projects.createProject('Alpha'))._id.toString();
});

describe('beat.sets roster', () => {
  it('createBeat seeds sets [] and dedupes a provided roster', async () => {
    const plain = await Plots.createBeat({ projectId: p1, desc: 'One' });
    expect(plain.sets).toEqual([]);
    const withSets = await Plots.createBeat({
      projectId: p1,
      desc: 'Two',
      sets: ['Kitchen', 'kitchen', 'Rooftop'],
    });
    expect(withSets.sets).toEqual(['Kitchen', 'Rooftop']);
  });

  it('getPlot backfills sets [] on legacy beats', async () => {
    const beat = await Plots.createBeat({ projectId: p1, desc: 'Legacy' });
    const withField = await fakeDb.collection('plots').findOne({ project_id: p1 });
    const legacyBeats = withField.beats.map(({ sets, ...rest }) => rest);
    await fakeDb.collection('plots').updateOne(
      { project_id: p1 },
      { $set: { beats: legacyBeats } },
    );
    // sanity: field really gone before the lazy backfill runs
    const raw = await fakeDb.collection('plots').findOne({ project_id: p1 });
    expect(raw.beats[0].sets).toBeUndefined();
    const plot = await Plots.getPlot(p1);
    expect(plot.beats.find((b) => b._id.equals(beat._id)).sets).toEqual([]);
  });

  it('updateBeat accepts a sets array and dedupes it', async () => {
    const beat = await Plots.createBeat({ projectId: p1, desc: 'One' });
    const next = await Plots.updateBeat(p1, beat._id.toString(), {
      sets: ['Kitchen', 'KITCHEN', 'Alley'],
    });
    expect(next.sets).toEqual(['Kitchen', 'Alley']);
  });

  it('linkSetToBeat is idempotent; unlinkSetFromBeat is case-insensitive', async () => {
    const beat = await Plots.createBeat({ projectId: p1, desc: 'One' });
    await Plots.linkSetToBeat(p1, beat._id.toString(), 'Kitchen');
    const linkedTwice = await Plots.linkSetToBeat(p1, beat._id.toString(), 'kitchen');
    expect(linkedTwice.sets).toEqual(['Kitchen']);
    const unlinked = await Plots.unlinkSetFromBeat(p1, beat._id.toString(), 'KITCHEN');
    expect(unlinked.sets).toEqual([]);
  });

  it('unlinkSetFromAllBeats touches only beats carrying the name', async () => {
    const a = await Plots.createBeat({ projectId: p1, desc: 'One', sets: ['Kitchen'] });
    await Plots.createBeat({ projectId: p1, desc: 'Two', sets: ['Rooftop'] });
    const c = await Plots.createBeat({ projectId: p1, desc: 'Three', sets: ['kitchen', 'Alley'] });
    const res = await Plots.unlinkSetFromAllBeats(p1, 'Kitchen');
    expect(res.unlinked_from).toBe(2);
    const plot = await Plots.getPlot(p1);
    expect(plot.beats.find((b) => b._id.equals(a._id)).sets).toEqual([]);
    expect(plot.beats.find((b) => b._id.equals(c._id)).sets).toEqual(['Alley']);
  });
});
