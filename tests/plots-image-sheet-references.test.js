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

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('setBeatImageSheetReferences', () => {
  it('persists the reference id set on the beat and getBeat returns it', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'x' });
    const a = new ObjectId();
    const b = new ObjectId();
    await Plots.setBeatImageSheetReferences(projectId, beat._id, [a.toString(), b.toString()]);
    const fresh = await Plots.getBeat(projectId, beat._id);
    expect(fresh.image_sheet_reference_ids.map(String)).toEqual([a.toString(), b.toString()]);
  });
});

describe('computeImageSheetPrefillIds', () => {
  it('prefers the saved reference set', () => {
    const id = new ObjectId().toString();
    const beat = { image_sheet_reference_ids: [id], artworks: [{ reference_image_ids: [new ObjectId()] }] };
    expect(Plots.computeImageSheetPrefillIds(beat)).toEqual([id]);
  });
  it('falls back to the union of all artwork reference ids when none saved', () => {
    const r1 = new ObjectId().toString();
    const r2 = new ObjectId().toString();
    const beat = {
      image_sheet_reference_ids: [],
      artworks: [
        { reference_image_ids: [r1, r2] },
        { reference_image_ids: [r2] }, // duplicate dropped
      ],
    };
    expect(Plots.computeImageSheetPrefillIds(beat)).toEqual([r1, r2]);
  });
  it('returns [] when nothing is available', () => {
    expect(Plots.computeImageSheetPrefillIds({})).toEqual([]);
  });
});
