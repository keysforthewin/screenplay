import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/web/auth.js', () => ({ requireSession: () => (_req, _res, next) => next() }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));
vi.mock('../src/web/imageModelValidate.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, assertImageModelConfigured: () => {} };
});
const editCalls = [];
vi.mock('../src/web/artworkJobs.js', async (importOriginal) => {
  const real = await importOriginal();
  const Artworks = await import('../src/mongo/artworks.js');
  return {
    ...real,
    generateArtworkImageInline: vi.fn(async () => ({ fileId: new ObjectId(), model: 'nano-banana-pro' })),
    // The real job edits the image in the background; here it only flips the
    // artwork to pending (as the real one does synchronously) and records the call.
    startEditArtworkJob: vi.fn(async (opts) => {
      editCalls.push(opts);
      const { artwork } = await Artworks.setArtworkStatus({ projectId: opts.projectId, hostType: opts.hostType, hostId: opts.hostId, artworkId: opts.artworkId, status: 'pending' });
      return artwork;
    }),
    undoArtworkEdit: vi.fn(async (opts) => {
      const cur = await Artworks.getArtwork(opts);
      const { artwork } = await Artworks.setArtworkResult({ ...opts, resultImageId: cur.artwork.previous_result_image_id });
      return artwork;
    }),
  };
});

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Sets = await import('../src/mongo/sets.js');
const AC = await import('../src/mongo/artworkCritiques.js');
const G = await import('../src/web/artworkCritique.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId, beat, setDoc;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('P'))._id.toString();
  setDoc = await Sets.createSet({ projectId, name: 'Lot', description: 'd' });
  beat = await Plots.createBeat({ projectId, name: 'B', body: 'EXT. LOT — DAY', sets: ['Lot'] });
});
afterEach(() => G._setArtworkCritiqueAnalyzerForTests(null));

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}
async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

const analyzer = () => ({
  requirements: async () => ({
    requirements: [{ subject_id: String(setDoc._id), subject_kind: 'set', category: 'view', summary: 'Lot wide', detail: 'd', quote: 'EXT. LOT', importance: 'essential' }],
    unlinked_mentions: [],
  }),
  audit: async () => ({ coverage: [], artworks: [], accuracy_score: 5, summary: 's' }),
  proposals: async ({ requirements }) => ({ proposals: requirements.map((r) => ({ requirement_ids: [r.id], name: 'Lot wide', prompt: 'p', reference_indexes: [], rationale: '' })) }),
});

async function settle(jobId) {
  for (let i = 0; i < 200; i++) {
    const j = G.getArtworkCritiqueJob(jobId);
    if (!j || ['done', 'partial', 'error'].includes(j.status)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function critiqued() {
  G._setArtworkCritiqueAnalyzerForTests(analyzer());
  const r = await post(`/api/beat/${beat._id}/artwork-critique`);
  expect(r.status).toBe(202);
  await settle(r.json.job_id);
  return AC.getBeatArtworkCritique(projectId, beat._id.toString());
}

describe('artwork critique routes', () => {
  it('GET returns null before a run and 404 for an unknown beat', async () => {
    expect((await get(`/api/beat/${beat._id}/artwork-critique`)).json).toEqual({ artwork_critique: null, climb: null });
    expect((await get(`/api/beat/${new ObjectId()}/artwork-critique`)).status).toBe(404);
    expect((await get(`/api/beat/99/artwork-critique`)).status).toBe(404);
  });

  it('POST starts a run (202), resolves by order, and 409s while busy', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    G._setArtworkCritiqueAnalyzerForTests({ ...analyzer(), requirements: async () => { await gate; return analyzer().requirements(); } });
    const r = await post(`/api/beat/${beat.order}/artwork-critique`);
    expect(r.status).toBe(202);
    expect(r.json.beat_id).toBe(beat._id.toString());
    expect((await post(`/api/beat/${beat._id}/artwork-critique`)).status).toBe(409);
    release();
    await settle(r.json.job_id);
    const c = (await get(`/api/beat/${beat._id}/artwork-critique`)).json.artwork_critique;
    expect(c.status).toBe('done');
    expect(c.proposals).toHaveLength(1);
  });

  it('POST validates the stage; DELETE clears the critique', async () => {
    G._setArtworkCritiqueAnalyzerForTests(analyzer());
    expect((await post(`/api/beat/${beat._id}/artwork-critique`, { stage: 'nope' })).status).toBe(400);
    expect((await post(`/api/beat/${beat._id}/artwork-critique`, { stage: 'quality' })).status).toBe(409);
    const r = await post(`/api/beat/${beat._id}/artwork-critique`, { stage: 'coverage' });
    expect(r.status).toBe(202);
    await settle(r.json.job_id);
    expect((await get(`/api/beat/${beat._id}/artwork-critique`)).json.artwork_critique.status).toBe('done');
    const del = await fetch(`${baseUrl}/api/beat/${beat._id}/artwork-critique`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await get(`/api/beat/${beat._id}/artwork-critique`)).json).toEqual({ artwork_critique: null, climb: null });
    expect((await fetch(`${baseUrl}/api/beat/${new ObjectId()}/artwork-critique`, { method: 'DELETE' })).status).toBe(404);
  });

  it('generate validates, returns 202 with a pollable job, and 404s a job from another project', async () => {
    const c = await critiqued();
    const pid = String(c.proposals[0]._id);
    const base = `/api/beat/${beat._id}/artwork-critique`;
    expect((await post(`${base}/generate`, { proposal_ids: [], model: 'nano-banana-pro' })).status).toBe(400);
    expect((await post(`${base}/generate`, { proposal_ids: [String(new ObjectId())], model: 'nano-banana-pro' })).status).toBe(400);
    expect((await post(`${base}/generate`, { proposal_ids: [pid], model: 'bogus' })).status).toBe(400);
    expect((await post(`${base}/generate`, { proposal_ids: [pid], model: 'nano-banana-pro', overrides: { [pid]: { prompt: '' } } })).status).toBe(400);
    const r = await post(`${base}/generate`, { proposal_ids: [pid], model: 'nano-banana-pro' });
    expect(r.status).toBe(202);
    expect(r.json.planned).toBe(1);
    const j = await get(`${base}/generate/${r.json.job_id}`);
    expect(j.status).toBe(200);
    expect(j.json.job.items[0].proposal_id).toBe(pid);
    expect((await get(`${base}/generate/${new ObjectId()}`)).status).toBe(404);
    const other = (await createProject('Q'))._id.toString();
    const res = await fetch(`${baseUrl}${base}/generate/${r.json.job_id}`, { headers: { 'X-Project-Id': other } });
    expect(res.status).toBe(404);
    for (let i = 0; i < 200; i++) {
      const jj = G.getArtworkGenerateJob(r.json.job_id);
      if (!jj || ['done', 'partial', 'error'].includes(jj.status)) break;
      await new Promise((rr) => setTimeout(rr, 5));
    }
  });

  it('fix: applies the suggested edit as an in-line edit, syncs the result onto the entry, and undoes', async () => {
    const Artworks = await import('../src/mongo/artworks.js');
    const originalImage = new ObjectId();
    const { artwork } = await Artworks.appendDoneArtwork({ projectId, hostType: 'set', hostId: String(setDoc._id), resultImageId: originalImage, name: 'Lot plate' });
    const aid = String(artwork._id);
    G._setArtworkCritiqueAnalyzerForTests({
      ...analyzer(),
      audit: async () => ({
        coverage: [], accuracy_score: 4, summary: 's',
        artworks: [{ index: 1, issues: [{ kind: 'prop', note: 'No kiosk.' }], suggested_edit: 'Add a ticket kiosk by the doors; keep everything else exactly as it is.' }],
      }),
    });
    const run = await post(`/api/beat/${beat._id}/artwork-critique`);
    await settle(run.json.job_id);
    const base = `/api/beat/${beat._id}/artwork-critique/artworks/${aid}`;

    expect((await post(`/api/beat/${beat._id}/artwork-critique/artworks/${new ObjectId()}/fix`)).status).toBe(404);
    expect((await post(`${base}/fix`, { prompt: '   ' })).status).toBe(400);
    expect((await post(`${base}/fix`, { model: 'bogus' })).status).toBe(400);
    expect((await post(`${base}/fix/undo`)).status).toBe(409);
    // A climb edits these artworks itself: a manual fix is refused while it holds the beat.
    expect(G.holdArtworkClimb(beat._id.toString())).toBe(true);
    expect((await post(`${base}/fix`, {})).status).toBe(409);
    G.releaseArtworkClimb(beat._id.toString());

    editCalls.length = 0;
    const started = await post(`${base}/fix`, {});
    expect(started.status).toBe(202);
    expect(started.json.host_type).toBe('set');
    expect(started.json.artwork.fix).toMatchObject({ status: 'generating', model: 'nano-banana-pro', source_image_id: String(originalImage) });
    expect(started.json.artwork.fix.prompt).toBe('Add a ticket kiosk by the doors; keep everything else exactly as it is.');
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toMatchObject({ hostType: 'set', hostId: String(setDoc._id), artworkId: aid, referenceImageIds: [] });
    // Busy while the edit runs (the artwork is pending).
    expect((await post(`${base}/fix`, {})).status).toBe(409);
    expect((await get(base)).json.artwork.fix.status).toBe('generating');

    // The background edit lands a new image.
    const fixedImage = new ObjectId();
    await Artworks.setArtworkResult({ projectId, hostType: 'set', hostId: String(setDoc._id), artworkId: aid, resultImageId: fixedImage, rotateToPrevious: true });
    const synced = await get(base);
    expect(synced.json.artwork.fix).toMatchObject({ status: 'done', result_image_id: String(fixedImage) });
    expect(synced.json.artwork.result_image_id).toBe(String(fixedImage));
    expect(synced.json.artwork.issues).toHaveLength(1);
    // The critique GET shows the synced entry too.
    const c = (await get(`/api/beat/${beat._id}/artwork-critique`)).json.artwork_critique;
    expect(String(c.subjects[0].artworks[0].result_image_id)).toBe(String(fixedImage));

    // A rewritten instruction is what runs the second time.
    const again = await post(`${base}/fix`, { prompt: 'Make the kiosk red.' });
    expect(again.status).toBe(202);
    expect(editCalls[1].prompt).toBe('Make the kiosk red.');
    await Artworks.setArtworkResult({ projectId, hostType: 'set', hostId: String(setDoc._id), artworkId: aid, resultImageId: new ObjectId(), rotateToPrevious: true });

    const undone = await post(`${base}/fix/undo`);
    expect(undone.status).toBe(200);
    expect(undone.json.artwork.fix.status).toBe('undone');
    expect(undone.json.artwork.result_image_id).toBe(String(fixedImage));
    expect((await post(`${base}/fix/undo`)).status).toBe(409);
  });

  it('fix: a failed edit is reported on the entry', async () => {
    const Artworks = await import('../src/mongo/artworks.js');
    const { artwork } = await Artworks.appendDoneArtwork({ projectId, hostType: 'set', hostId: String(setDoc._id), resultImageId: new ObjectId(), name: 'Lot plate' });
    const aid = String(artwork._id);
    G._setArtworkCritiqueAnalyzerForTests({
      ...analyzer(),
      audit: async () => ({ coverage: [], accuracy_score: 4, summary: 's', artworks: [{ index: 1, issues: [{ kind: 'light', note: 'Night.' }], suggested_edit: 'Make it daylight.' }] }),
    });
    const run = await post(`/api/beat/${beat._id}/artwork-critique`);
    await settle(run.json.job_id);
    const base = `/api/beat/${beat._id}/artwork-critique/artworks/${aid}`;
    expect((await post(`${base}/fix`, {})).status).toBe(202);
    await Artworks.setArtworkStatus({ projectId, hostType: 'set', hostId: String(setDoc._id), artworkId: aid, status: 'error', errorMessage: 'provider down' });
    const r = await get(base);
    expect(r.json.artwork.fix).toMatchObject({ status: 'error', error_message: 'provider down' });
    // Retry is allowed once the artwork is no longer pending.
    expect((await post(`${base}/fix`, {})).status).toBe(202);
  });

  it('dismiss and restore a proposal; 404 unknown', async () => {
    const c = await critiqued();
    const pid = String(c.proposals[0]._id);
    const base = `/api/beat/${beat._id}/artwork-critique/proposals`;
    expect((await post(`${base}/${new ObjectId()}/dismiss`)).status).toBe(404);
    expect((await post(`${base}/nope/dismiss`)).status).toBe(404);
    expect((await post(`${base}/${pid}/dismiss`)).json.proposal.status).toBe('dismissed');
    expect((await AC.getArtworkCritiqueProposal(projectId, beat._id.toString(), pid)).status).toBe('dismissed');
    expect((await post(`${base}/${pid}/restore`)).json.proposal.status).toBe('proposed');
  });
});
