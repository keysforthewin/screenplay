// The writing climb (critique → rewrite → critique) against the fake Mongo.
// The facet generator seam scores a body by a marker in its text ("score:N");
// the stubbed Anthropic client plays the strategist, the rewriter, the edit
// planner and the wall summary. `nextScores` is the score each attempt's
// result will carry, whichever mode the climb picks for it: a full rewrite
// returns a new body "REWRITE score:N", an edit swaps the body's score token.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({ getDb: () => fakeDb, connectMongo: async () => fakeDb }));
vi.mock('../src/web/auth.js', () => ({ requireSession: () => (_req, _res, next) => next() }));
vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(), announceCharacterMedia: vi.fn(), announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(), announceLibraryMedia: vi.fn(), announceBatchSummary: vi.fn(),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const G = await import('../src/web/critiqueGenerate.js');
const Core = await import('../src/web/climbCore.js');
const { getBeatClimb } = await import('../src/mongo/climbs.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server, baseUrl, projectId, beatId;
let nextScores; // the score of each attempt's result, in order
let plannerInputs; // what the strategist / edit planner was shown: [{mode, text}]
let modelDelayMs; // slows the stubbed model so a test can act while the climb runs

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
  await Plots.updatePlot(projectId, { synopsis: 'S' });
  beatId = (await Plots.createBeat({ projectId, name: 'B', desc: 'THE SPINE NOTE', body: 'ORIGINAL score:5' }))._id.toString();
  nextScores = [];
  plannerInputs = [];
  modelDelayMs = 0;
  // A body's score is whatever follows "score:" in it.
  G._setFacetGeneratorForTests(async (_facet, ctx) => {
    const m = /score:(\d+)/.exec(JSON.stringify(ctx));
    return { score: Number(m?.[1] ?? 1), comments: 'note' };
  });
  let n = 0;
  _setAnthropicClientForTests({
    messages: {
      create: async ({ system, messages }) => {
        if (modelDelayMs) await new Promise((r) => setTimeout(r, modelDelayMs));
        const user = messages[0].content;
        let text = 'WALL: pacing and voice trade off.';
        if (/strategist/.test(system)) {
          plannerInputs.push({ mode: 'rewrite', text: user });
          text = `PLAN ${++n}`;
        } else if (/rewriting one beat/.test(system)) {
          text = `REWRITE score:${nextScores.shift()}`;
        } else if (/targeted corrections/.test(system)) {
          plannerInputs.push({ mode: 'edit', text: user });
          const current = /score:\d+/.exec(user.slice(user.lastIndexOf('# Current beat body')))[0];
          text = JSON.stringify({ plan: `EDIT PLAN ${++n}`, edits: [{ find: current, replace: `score:${nextScores.shift()}`, issue: 'the score' }] });
        }
        return { content: [{ type: 'text', text }] };
      },
    },
  });
});
afterEach(() => { G._setFacetGeneratorForTests(null); _setAnthropicClientForTests(null); });

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}
async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: await res.json() };
}
const finished = async () => {
  for (let i = 0; i < 400; i++) {
    if (!Core.isClimbRunning('writing', beatId)) return getBeatClimb(projectId, beatId, 'writing');
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('climb did not finish');
};

describe('writing climb', () => {
  it('validates the request', async () => {
    expect((await post(`/api/beat/${beatId}/critique/climb`, {})).status).toBe(400);
    expect((await post(`/api/beat/${beatId}/critique/climb`, { target: 12 })).status).toBe(400);
    expect((await post('/api/beat/999/critique/climb', { target: 8 })).status).toBe(404);
    expect((await post(`/api/beat/${beatId}/critique/climb/cancel`, {})).status).toBe(409);
    expect((await get(`/api/beat/${beatId}/critique`)).json.climb).toBeNull();
  });

  it('rewrites until the target, keeps the best body and fills the undo slot with the original', async () => {
    nextScores = [4, 7, 9];
    modelDelayMs = 40;
    const { status, json } = await post(`/api/beat/${beatId}/critique/climb`, { target: 8.5, direction: 'keep it dry' });
    expect(status).toBe(202);
    expect(json.climb).toMatchObject({ status: 'running', target: 8.5, stop_after: 3, direction: 'keep it dry' });
    // The climb owns the beat while it runs.
    expect((await post(`/api/beat/${beatId}/critique`, {})).status).toBe(409);
    expect((await post(`/api/beat/${beatId}/regenerate`, {})).status).toBe(409);
    expect((await post(`/api/beat/${beatId}/critique/climb`, { target: 8 })).status).toBe(409);

    const climb = await finished();
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'target', start_score: 5, best_score: 9, wall_summary: null });
    expect(climb.attempts.map((a) => [a.score, a.kept])).toEqual([[4, false], [7, true], [9, true]]);
    const beat = await Plots.getBeat(projectId, beatId);
    // Below 7 the climb rewrites; the discarded rewrite switches it to edits;
    // from 7 up it stays on edits.
    expect(climb.attempts.map((a) => a.detail.mode)).toEqual(['rewrite', 'edit', 'edit']);
    expect(climb.attempts[1].detail.edits).toBe(1);
    expect(plannerInputs.map((i) => i.mode)).toEqual(['rewrite', 'edit', 'edit']);
    expect(beat.body).toBe('ORIGINAL score:9');
    expect(beat.previous_body).toBe('ORIGINAL score:5');
    expect(beat.critique.overall).toBe(9);
    expect(beat.critique.strategy).toMatch(/^Targeted edits \(1 applied\)/);
    expect(beat.critique.strategy).toContain('EDIT PLAN 3');
    // The direction reaches the planner; the discarded plan and what the
    // critics said about it are shown to the next attempt only.
    expect(plannerInputs[0].text).toContain('keep it dry');
    expect(plannerInputs[0].text).not.toContain('did NOT raise the score');
    expect(plannerInputs[1].text).toContain('did NOT raise the score');
    expect(plannerInputs[1].text).toContain('Attempt 1 (full rewrite): overall 4/10');
    expect(plannerInputs[1].text).toContain('PLAN 1');
    expect(plannerInputs[1].text).toContain('ORIGINAL score:5');
    expect(plannerInputs[2].text).not.toContain('did NOT raise the score');
    // Every planner call is shown what the critics score against.
    expect(plannerInputs[0].text).toContain('What this beat must agree with');
    expect(plannerInputs[0].text).toContain('THE SPINE NOTE');
    expect((await get(`/api/beat/${beatId}/critique`)).json.climb.stop_reason).toBe('target');
  });

  it('stops after N attempts without an increase, restores the best version and says why', async () => {
    nextScores = [6, 6, 3, 9];
    await post(`/api/beat/${beatId}/critique/climb`, { target: 9, stop_after: 2 });
    const climb = await finished();
    expect(climb).toMatchObject({ status: 'done', stop_reason: 'stalled', start_score: 5, best_score: 6, stalls: 2 });
    expect(climb.attempts).toHaveLength(3);
    expect(climb.wall_summary).toBe('WALL: pacing and voice trade off.');
    expect(climb.attempts[0].detail.facets).toBeTruthy();
    const beat = await Plots.getBeat(projectId, beatId);
    expect(climb.attempts.map((a) => a.detail.mode)).toEqual(['rewrite', 'rewrite', 'edit']);
    expect(beat.body).toBe('REWRITE score:6');
    expect(beat.critique.overall).toBe(6);
    expect(beat.critique.status).toBe('done');
    expect(beat.previous_body).toBe('ORIGINAL score:5');
  });

  it('leaves the beat untouched when no rewrite beats the original', async () => {
    nextScores = [2];
    await post(`/api/beat/${beatId}/critique/climb`, { target: 9, stop_after: 1 });
    const climb = await finished();
    expect(climb.stop_reason).toBe('stalled');
    const beat = await Plots.getBeat(projectId, beatId);
    expect(beat.body).toBe('ORIGINAL score:5');
    expect(beat.critique.overall).toBe(5);
    expect(beat.previous_body ?? null).toBeNull();
    // Released afterwards.
    expect((await post(`/api/beat/${beatId}/critique`, {})).status).toBe(202);
    for (let i = 0; i < 100; i++) {
      const b = await Plots.getBeat(projectId, beatId);
      if (b.critique?.status === 'done') break;
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  it('starts with targeted edits when the beat already scores 7 or higher', async () => {
    await Plots.updateBeat(projectId, beatId, { body: 'GOOD score:7' });
    nextScores = [9];
    await post(`/api/beat/${beatId}/critique/climb`, { target: 8.5 });
    const climb = await finished();
    expect(climb.stop_reason).toBe('target');
    expect(climb.attempts[0].detail).toMatchObject({ mode: 'edit', edits: 1 });
    expect((await Plots.getBeat(projectId, beatId)).body).toBe('GOOD score:9');
  });

  it('cancel stops the climb and puts the best body back', async () => {
    nextScores = [6, 7, 8, 8, 8];
    modelDelayMs = 40;
    await post(`/api/beat/${beatId}/critique/climb`, { target: 9 });
    const { status, json } = await post(`/api/beat/${beatId}/critique/climb/cancel`, {});
    expect(status).toBe(200);
    expect(json.climb.cancel_requested).toBe(true);
    const climb = await finished();
    expect(climb.stop_reason).toBe('cancelled');
    const beat = await Plots.getBeat(projectId, beatId);
    expect(beat.body).toMatch(/score:(5|6|7)/);
    expect(beat.critique.overall).toBe(Number(/score:(\d)/.exec(beat.body)[1]));
  });
});
