// With Hocuspocus running, the gateway's create helpers seed a new row's text
// fragments BEFORE inserting the Mongo row. Seeding after the insert let a
// store tick see the new row with empty fragments and write '' over the text
// the row was created with. Here the direct-connection mock records, for each
// fragment write, whether the row already existed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';
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

const docs = new Map();
const seedWrites = [];
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(async (roomName, _ctx, fn) => {
    if (!docs.has(roomName)) docs.set(roomName, new Y.Doc());
    const doc = docs.get(roomName);
    const before = new Set(doc.share.keys());
    const result = fn(doc);
    for (const field of doc.share.keys()) {
      if (before.has(field)) continue;
      const m = field.match(/^(?:item|scene):([a-f0-9]{24}):/);
      const id = m && new ObjectId(m[1]);
      const rowExists = !!(
        (await fakeDb.collection('video_prompts').findOne({ _id: id })) ||
        (await fakeDb.collection('video_scenes').findOne({ _id: id })) ||
        (await fakeDb.collection('dialogs').findOne({ _id: id }))
      );
      seedWrites.push({ roomName, field, rowExists });
    }
    return result;
  }),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => true,
}));

vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({
  deleteEntity: async () => {},
  deleteProjectChunks: async () => 0,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Gateway = await import('../src/web/gateway.js');
const Hocuspocus = await import('../src/web/hocuspocus.js');
const Plots = await import('../src/mongo/plots.js');
const { fragmentToMarkdown } = await import('../src/web/headlessEditor.js');

let projectId;
let beat;
beforeEach(async () => {
  fakeDb.reset();
  docs.clear();
  seedWrites.length = 0;
  projectId = (await createProject('Test Project'))._id.toString();
  beat = await Plots.createBeat({ projectId, name: 'Diner', desc: 'A diner scene.' });
});

describe('gateway create helpers seed fragments before the row exists', () => {
  it('cut: all four fragments are written before the insert, and the row carries the same text', async () => {
    const scene = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id.toString(), title: 'Scene' });
    seedWrites.length = 0;
    const p = await Gateway.createVideoPromptViaGateway({
      projectId,
      sceneId: scene._id.toString(),
      title: 'Cut 1',
      prompt: 'Wide from the counter end.',
      startFramePrompt: 'Frontal wide.',
      endFramePrompt: 'Door shut.',
    });
    const id = p._id.toString();
    expect(seedWrites.map((w) => w.field)).toEqual([
      `item:${id}:title`,
      `item:${id}:prompt`,
      `item:${id}:start_frame_prompt`,
      `item:${id}:end_frame_prompt`,
    ]);
    expect(seedWrites.every((w) => !w.rowExists)).toBe(true);
    expect(p.title).toBe('Cut 1');
    expect(p.prompt).toBe('Wide from the counter end.');
    expect(p.start_frame.prompt).toBe('Frontal wide.');
    expect(p.end_frame.prompt).toBe('Door shut.');
    const doc = docs.get(`video_prompts:${beat._id}`);
    expect(fragmentToMarkdown(doc, `item:${id}:title`)).toBe('Cut 1');
    expect(fragmentToMarkdown(doc, `item:${id}:prompt`)).toBe('Wide from the counter end.');
    expect(fragmentToMarkdown(doc, `item:${id}:start_frame_prompt`)).toBe('Frontal wide.');
    expect(fragmentToMarkdown(doc, `item:${id}:end_frame_prompt`)).toBe('Door shut.');
  });

  it('cut: a bare POST /cut-style create still seeds its four (empty) fragments before the insert', async () => {
    const scene = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id.toString() });
    seedWrites.length = 0;
    const calls = Hocuspocus.withDirectDocument.mock.calls.length;
    const p = await Gateway.createVideoPromptViaGateway({ projectId, sceneId: scene._id.toString() });
    const id = p._id.toString();
    // One direct write per fragment, each addressed to this beat's room.
    const mine = Hocuspocus.withDirectDocument.mock.calls.slice(calls);
    expect(mine.map((c) => c[0])).toEqual(Array(4).fill(`video_prompts:${beat._id}`));
    expect(seedWrites.every((w) => w.field.startsWith(`item:${id}:`) && !w.rowExists)).toBe(true);
    expect(p).toMatchObject({ title: '', prompt: '', start_frame: null, end_frame: null });
  });

  it('scene: the title is seeded before the insert and stored on the row', async () => {
    const s = await Gateway.createVideoSceneViaGateway({ projectId, beatId: beat._id.toString(), title: 'The diner' });
    expect(seedWrites).toEqual([{ roomName: `video_prompts:${beat._id}`, field: `scene:${s._id}:title`, rowExists: false }]);
    expect(s.title).toBe('The diner');
    expect(s.order).toBe(1);
    expect(fragmentToMarkdown(docs.get(`video_prompts:${beat._id}`), `scene:${s._id}:title`)).toBe('The diner');
  });

  it('dialog: body and character are seeded before the insert and stored on the row', async () => {
    const d = await Gateway.createDialogViaGateway({
      projectId,
      beatId: beat._id,
      body: 'I am sorry I am late',
      character: 'Tom',
      seedFragments: { body: 'I am sorry I am late', character: 'Tom' },
    });
    expect(seedWrites.map((w) => [w.field, w.rowExists])).toEqual([
      [`item:${d._id}:body`, false],
      [`item:${d._id}:character`, false],
    ]);
    expect(d.body).toBe('I am sorry I am late');
    expect(d.character).toBe('Tom');
  });
});
