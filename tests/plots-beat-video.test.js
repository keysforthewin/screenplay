// Assembled beat video pointer on beats (video_file_id / duration / generated_at).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/web/hocuspocus.js', () => ({
  getRoomDocument: () => null,
  withDirectDocument: vi.fn(),
  broadcastRoomStateless: vi.fn(),
  isHocuspocusRunning: () => false,
}));
const deleted = [];
vi.mock('../src/mongo/attachments.js', async () => {
  const actual = await vi.importActual('../src/mongo/attachments.js');
  return { ...actual, deleteAttachment: vi.fn(async (id) => { deleted.push(String(id)); }) };
});

const { createProject } = await import('../src/mongo/projects.js');
const { createBeat, getBeat, setBeatVideo } = await import('../src/mongo/plots.js');
const { setBeatVideoViaGateway } = await import('../src/web/gateway.js');

let projectId;
beforeEach(async () => {
  fakeDb.reset();
  deleted.length = 0;
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('beat video fields', () => {
  it('new beats carry null video fields', async () => {
    const b = await createBeat({ projectId, name: 'Diner' });
    expect(b.video_file_id).toBeNull();
    expect(b.video_duration_seconds).toBeNull();
    expect(b.video_generated_at).toBeNull();
  });

  it('setBeatVideo sets and clears the pointer', async () => {
    const b = await createBeat({ projectId, name: 'Diner' });
    const fid = new ObjectId();
    const set = await setBeatVideo(projectId, b._id, { fileId: fid, durationSeconds: 12.4 });
    expect(set.video_file_id).toBe(fid.toString());
    expect(set.video_duration_seconds).toBe(12.4);
    expect(set.video_generated_at).toBeInstanceOf(Date);
    const cleared = await setBeatVideo(projectId, b._id, { fileId: null });
    expect(cleared.video_file_id).toBeNull();
    expect(cleared.video_duration_seconds).toBeNull();
    expect(cleared.video_generated_at).toBeNull();
  });

  it('the gateway deletes the previous file when replacing or discarding', async () => {
    const b = await createBeat({ projectId, name: 'Diner' });
    const first = new ObjectId();
    const second = new ObjectId();
    await setBeatVideoViaGateway({ projectId, beatId: b._id, fileId: first, durationSeconds: 5 });
    expect(deleted).toEqual([]);
    await setBeatVideoViaGateway({ projectId, beatId: b._id, fileId: second, durationSeconds: 6 });
    expect(deleted).toEqual([first.toString()]);
    const cleared = await setBeatVideoViaGateway({ projectId, beatId: b._id, fileId: null });
    expect(deleted).toEqual([first.toString(), second.toString()]);
    expect(cleared.video_file_id).toBeNull();
    expect((await getBeat(projectId, b._id)).video_file_id).toBeNull();
  });
});
