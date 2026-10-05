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

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const A = await import('../src/mongo/artworkCritiques.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
});

const setId = new ObjectId();
const charId = new ObjectId();
const subjects = [{ kind: 'set', id: setId, name: 'Lot' }, { kind: 'character', id: charId, name: 'Sarah' }];

describe('artwork critique mongo helpers', () => {
  it('a new beat carries artwork_critique: null and pending overwrites a previous run', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    expect((await Plots.getBeat(projectId, beat._id.toString())).artwork_critique).toBeNull();
    await A.setArtworkCritiquePending(projectId, beat._id.toString(), { model: 'm', subjects });
    await A.appendArtworkCritiqueProposals(projectId, beat._id.toString(), [{ _id: new ObjectId(), name: 'old', status: 'proposed' }]);
    await A.setArtworkCritiquePending(projectId, beat._id.toString(), { model: 'm2', subjects: subjects.slice(0, 1) });
    const c = await A.getBeatArtworkCritique(projectId, beat._id.toString());
    expect(c.status).toBe('pending');
    expect(c.model).toBe('m2');
    expect(c.subjects).toHaveLength(1);
    expect(c.subjects[0]).toMatchObject({ kind: 'set', name: 'Lot', status: 'pending', requirements: [], artworks: [] });
    expect(c.proposals).toEqual([]);
  });

  it('beginArtworkCritiqueRun keeps what the last run learned and drops subjects that left the roster', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const id = beat._id.toString();
    // Nothing on file yet → a plain pending doc.
    expect((await A.beginArtworkCritiqueRun(projectId, id, { model: 'm', subjects })).proposals).toEqual([]);
    const entry = { artwork_id: new ObjectId(), score: 8, fits: [], audited_image_id: new ObjectId(), req_sig: 's' };
    await A.updateArtworkCritiqueSubject(projectId, id, setId, { requirements: [{ id: 'r1' }], artworks: [entry], status: 'done', req_sig: 's', inventory: { total: 1 } });
    await A.appendArtworkCritiqueProposals(projectId, id, [
      { _id: new ObjectId(), name: 'set one', status: 'dismissed', host_type: 'set', host_id: setId },
      { _id: new ObjectId(), name: 'char one', status: 'proposed', host_type: 'character', host_id: charId },
    ]);
    await A.setArtworkCritiqueMeta(projectId, id, { requirements_sig: 'run', bogus: 1 });
    await A.finalizeArtworkCritique(projectId, id, { status: 'done', coverage: { pct: 50 }, warnings: ['old'] });

    const newId = new ObjectId();
    await A.beginArtworkCritiqueRun(projectId, id, { model: 'm2', subjects: [subjects[0], { kind: 'set', id: newId, name: 'Lobby' }] });
    const c = await A.getBeatArtworkCritique(projectId, id);
    expect(c).toMatchObject({ status: 'pending', model: 'm2', warnings: ['old'], requirements_sig: 'run', coverage: { pct: 50 } });
    expect(c.bogus).toBeUndefined();
    expect(c.subjects.map((s) => s.name)).toEqual(['Lot', 'Lobby']);
    expect(c.subjects[0]).toMatchObject({ status: 'pending', req_sig: 's', requirements: [{ id: 'r1' }], inventory: { total: 1 } });
    expect(c.subjects[0].artworks[0].score).toBe(8);
    expect(c.subjects[1]).toMatchObject({ status: 'pending', requirements: [], artworks: [] });
    expect(c.proposals.map((p) => p.name)).toEqual(['set one']); // the character left the beat
  });

  it('backfills artwork_critique on a legacy beat', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    const plots = fakeDb.collection('plots');
    const doc = await plots.findOne({ project_id: projectId });
    delete doc.beats[0].artwork_critique;
    await plots.updateOne({ project_id: projectId }, { $set: { beats: doc.beats } });
    expect((await Plots.getBeat(projectId, beat._id.toString())).artwork_critique).toBeNull();
  });

  it('updates one subject by id and appends/updates proposals', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await A.setArtworkCritiquePending(projectId, beat._id.toString(), { model: 'm', subjects });
    const reqs = [{ id: `set:${setId}:1`, summary: 'Lot wide', status: 'missing', covered_by: [] }];
    expect(await A.updateArtworkCritiqueSubject(projectId, beat._id.toString(), setId, { requirements: reqs, status: 'done', bogus: 1 })).toBe(1);
    let c = await A.getBeatArtworkCritique(projectId, beat._id.toString());
    expect(c.subjects[0].requirements).toEqual(reqs);
    expect(c.subjects[0].status).toBe('done');
    expect(c.subjects[0].bogus).toBeUndefined();
    expect(c.subjects[1].status).toBe('pending');

    const p1 = new ObjectId();
    const p2 = new ObjectId();
    await A.appendArtworkCritiqueProposals(projectId, beat._id.toString(), [
      { _id: p1, name: 'one', status: 'proposed' },
      { _id: p2, name: 'two', status: 'proposed' },
    ]);
    const artworkId = new ObjectId();
    expect(await A.updateArtworkCritiqueProposal(projectId, beat._id.toString(), p2, { status: 'done', artwork_id: artworkId })).toBe(1);
    expect(await A.updateArtworkCritiqueProposal(projectId, beat._id.toString(), new ObjectId(), { status: 'done' })).toBe(0);
    c = await A.getBeatArtworkCritique(projectId, beat._id.toString());
    expect(c.proposals).toHaveLength(2);
    expect(c.proposals[0].status).toBe('proposed');
    expect(c.proposals[1]).toMatchObject({ status: 'done', artwork_id: artworkId });
    expect((await A.getArtworkCritiqueProposal(projectId, beat._id.toString(), p1)).name).toBe('one');
  });

  it('finalizes status, coverage, warnings and unlinked mentions', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', body: 'b' });
    await A.setArtworkCritiquePending(projectId, beat._id.toString(), { model: 'm', subjects });
    await A.finalizeArtworkCritique(projectId, beat._id.toString(), {
      status: 'partial', coverage: { total: 2, covered: 1, partial: 0, missing: 1, pct: 50 }, warnings: ['w'], unlinked_mentions: [{ name: 'X', kind: 'set', quote: 'q' }],
    });
    const c = await A.getBeatArtworkCritique(projectId, beat._id.toString());
    expect(c).toMatchObject({ status: 'partial', coverage: { pct: 50 }, warnings: ['w'], unlinked_mentions: [{ name: 'X' }] });
  });

  it('throws for a beat in another project', async () => {
    const other = (await createProject('Q'))._id.toString();
    const beat = await Plots.createBeat({ projectId: other, name: 'B', body: 'b' });
    expect(await A.getBeatArtworkCritique(projectId, beat._id.toString())).toBeNull();
    await expect(A.setArtworkCritiquePending(projectId, beat._id.toString(), { model: 'm', subjects })).rejects.toThrow(/Beat not found/);
  });
});
