// PATCH /api/projects/:id (rename) and DELETE /api/projects/:id (full cascade).
//
// The isolation test is the important one: deleting project A must leave every
// row belonging to project B untouched.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// RAG is best-effort and network-backed; assert it is *called* with the right
// project id rather than standing up Chroma.
const deleteProjectChunks = vi.fn(async () => true);
vi.mock('../src/rag/indexer.js', () => ({
  deleteProjectChunks: (...a) => deleteProjectChunks(...a),
}));

const Projects = await import('../src/mongo/projects.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r()));
});
beforeEach(() => {
  fakeDb.reset();
  deleteProjectChunks.mockClear();
});

const patch = (path, body) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const del = (path, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, { method: 'DELETE', headers });

const docs = (name) => fakeDb.collection(name)._docs;

// Populate one project with a row in every place the cascade must reach.
async function seedProjectContent(pid, { beatId, characterId, imageId, attachmentId }) {
  await fakeDb.collection('plots').insertOne({
    _id: new ObjectId(),
    project_id: pid,
    title: `plot-${pid}`,
    beats: [{ _id: beatId, order: 1, name: 'Beat' }],
  });
  await fakeDb
    .collection('characters')
    .insertOne({ _id: characterId, project_id: pid, name: 'Steve', name_lower: 'steve' });
  await fakeDb.collection('messages').insertOne({ _id: new ObjectId(), project_id: pid });
  await fakeDb
    .collection('storyboards')
    .insertOne({ _id: new ObjectId(), project_id: pid, beat_id: beatId });
  await fakeDb
    .collection('dialogs')
    .insertOne({ _id: new ObjectId(), project_id: pid, beat_id: beatId });
  await fakeDb.collection('edit_announcements').insertOne({ _id: new ObjectId(), project_id: pid });
  for (const key of ['character_template', 'plot_template', 'director_notes']) {
    await fakeDb.collection('prompts').insertOne({ _id: `${pid}:${key}`, project_id: pid });
  }
  await fakeDb
    .collection('images.files')
    .insertOne({ _id: imageId, metadata: { project_id: pid } });
  await fakeDb.collection('images.chunks').insertOne({ _id: new ObjectId(), files_id: imageId });
  await fakeDb
    .collection('attachments.files')
    .insertOne({ _id: attachmentId, metadata: { project_id: pid } });
  await fakeDb
    .collection('attachments.chunks')
    .insertOne({ _id: new ObjectId(), files_id: attachmentId });
  for (const room of [
    `plot:${pid}`,
    `notes:${pid}`,
    `library:${pid}`,
    `beat:${beatId.toString()}`,
    `storyboards:${beatId.toString()}`,
    `dialogs:${beatId.toString()}`,
    `character:${characterId.toString()}`,
  ]) {
    await fakeDb.collection('yjs_docs').insertOne({ _id: room, state: 'x' });
  }
}

function makeIds() {
  return {
    beatId: new ObjectId(),
    characterId: new ObjectId(),
    imageId: new ObjectId(),
    attachmentId: new ObjectId(),
  };
}

describe('PATCH /api/projects/:id', () => {
  it('renames a project', async () => {
    const p = await Projects.createProject('Noir');
    const r = await patch(`/projects/${p._id}`, { title: 'Neo Noir' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: p._id.toString(), title: 'Neo Noir' });
    const after = await Projects.getProjectById(p._id);
    expect(after.title).toBe('Neo Noir');
    expect(after.title_lower).toBe('neo noir');
    // Title-only lookup follows the new name.
    expect(await Projects.getProjectByTitle('neo noir')).toBeTruthy();
    expect(await Projects.getProjectByTitle('Noir')).toBeNull();
  });

  it('allows a case-only rename of the same project', async () => {
    const p = await Projects.createProject('noir');
    const r = await patch(`/projects/${p._id}`, { title: 'Noir' });
    expect(r.status).toBe(200);
    expect((await Projects.getProjectById(p._id)).title).toBe('Noir');
  });

  it('409s on a duplicate title (case-insensitive)', async () => {
    await Projects.createProject('Western');
    const p = await Projects.createProject('Noir');
    const r = await patch(`/projects/${p._id}`, { title: 'western' });
    expect(r.status).toBe(409);
    expect((await Projects.getProjectById(p._id)).title).toBe('Noir');
  });

  it('400s on invalid titles', async () => {
    const p = await Projects.createProject('Noir');
    expect((await patch(`/projects/${p._id}`, { title: '  ' })).status).toBe(400);
    expect((await patch(`/projects/${p._id}`, { title: 'a/b' })).status).toBe(400);
    expect((await patch(`/projects/${p._id}`, { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await patch(`/projects/${p._id}`, {})).status).toBe(400);
  });

  it('404s on an unknown project id', async () => {
    await Projects.createProject('Noir');
    expect((await patch(`/projects/${new ObjectId()}`, { title: 'Nope' })).status).toBe(404);
    expect((await patch('/projects/not-an-id', { title: 'Nope' })).status).toBe(404);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('deletes every row the project owns', async () => {
    const keep = await Projects.createProject('Keeper');
    const doomed = await Projects.createProject('Doomed');
    const pid = doomed._id.toString();
    const ids = makeIds();
    await seedProjectContent(pid, ids);

    const r = await del(`/projects/${pid}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.title).toBe('Doomed');

    for (const name of [
      'plots',
      'characters',
      'messages',
      'storyboards',
      'dialogs',
      'edit_announcements',
      'prompts',
    ]) {
      expect(docs(name).filter((d) => d.project_id === pid)).toHaveLength(0);
    }
    expect(docs('images.files')).toHaveLength(0);
    expect(docs('images.chunks')).toHaveLength(0);
    expect(docs('attachments.files')).toHaveLength(0);
    expect(docs('attachments.chunks')).toHaveLength(0);
    expect(docs('yjs_docs')).toHaveLength(0);
    expect(await Projects.getProjectById(pid)).toBeNull();
    expect(deleteProjectChunks).toHaveBeenCalledWith(pid);
    // The other project survives.
    expect(await Projects.getProjectById(keep._id)).toBeTruthy();
  });

  it('leaves another project\'s rows completely intact', async () => {
    const keep = await Projects.createProject('Keeper');
    const doomed = await Projects.createProject('Doomed');
    const keepId = keep._id.toString();
    const doomedId = doomed._id.toString();
    const keepIds = makeIds();
    await seedProjectContent(keepId, keepIds);
    await seedProjectContent(doomedId, makeIds());

    expect((await del(`/projects/${doomedId}`)).status).toBe(200);

    for (const name of [
      'plots',
      'characters',
      'messages',
      'storyboards',
      'dialogs',
      'edit_announcements',
    ]) {
      expect(docs(name).filter((d) => d.project_id === keepId)).toHaveLength(1);
    }
    expect(docs('prompts').filter((d) => d.project_id === keepId)).toHaveLength(3);
    expect(docs('images.files')).toHaveLength(1);
    expect(docs('images.chunks')).toHaveLength(1);
    expect(docs('attachments.files')).toHaveLength(1);
    expect(docs('attachments.chunks')).toHaveLength(1);
    expect(docs('yjs_docs').map((d) => d._id).sort()).toEqual(
      [
        `plot:${keepId}`,
        `notes:${keepId}`,
        `library:${keepId}`,
        `beat:${keepIds.beatId}`,
        `storyboards:${keepIds.beatId}`,
        `dialogs:${keepIds.beatId}`,
        `character:${keepIds.characterId}`,
      ].sort(),
    );
  });

  it('409s (and deletes nothing) when it is the only project', async () => {
    const only = await Projects.createProject('Solo');
    const pid = only._id.toString();
    await seedProjectContent(pid, makeIds());

    const r = await del(`/projects/${pid}`);
    expect(r.status).toBe(409);
    expect(await Projects.getProjectById(pid)).toBeTruthy();
    expect(docs('plots').filter((d) => d.project_id === pid)).toHaveLength(1);
    expect(deleteProjectChunks).not.toHaveBeenCalled();
  });

  it('repoints a channel that was pointed at the deleted project', async () => {
    const keep = await Projects.createProject('Keeper');
    const doomed = await Projects.createProject('Doomed');
    await fakeDb.collection('channel_state').insertOne({
      _id: 'chan-1',
      current_project_id: doomed._id.toString(),
    });

    expect((await del(`/projects/${doomed._id}`)).status).toBe(200);
    const state = await fakeDb.collection('channel_state').findOne({ _id: 'chan-1' });
    expect(state.current_project_id).toBe(keep._id.toString());
  });

  it('404s on an unknown project id', async () => {
    await Projects.createProject('Noir');
    await Projects.createProject('Western');
    expect((await del(`/projects/${new ObjectId()}`)).status).toBe(404);
    expect((await del('/projects/not-an-id')).status).toBe(404);
  });

  it('ignores a stale X-Project-Id header (routes address by path id)', async () => {
    await Projects.createProject('Keeper');
    const doomed = await Projects.createProject('Doomed');
    const r = await del(`/projects/${doomed._id}`, { 'X-Project-Id': new ObjectId().toString() });
    expect(r.status).toBe(200);
  });

  it('deletes eleven_voices rows for the project and spares other projects', async () => {
    const keep = await Projects.createProject('Keeper');
    const doomed = await Projects.createProject('Doomed');
    const pid = doomed._id.toString();
    const otherPid = keep._id.toString();
    await fakeDb.collection('eleven_voices').insertMany([
      { _id: new ObjectId(), project_id: pid, voice_id: 'v1', name: 'Mine' },
      { _id: new ObjectId(), project_id: otherPid, voice_id: 'v1', name: 'Theirs' },
    ]);
    await del(`/projects/${pid}`);
    expect(await fakeDb.collection('eleven_voices').find({}).toArray()).toHaveLength(1);
    expect((await fakeDb.collection('eleven_voices').find({}).toArray())[0].project_id).toBe(otherPid);
  });
});
