import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
  closeMongo: async () => {},
}));

const { migrate } = await import('../scripts/migrate-multi-project.js');

const CHANNEL_ID = 'chan-123';
const beatId = new ObjectId();
const entityRoomId = `beat:${beatId.toString()}`;

async function seedLegacy() {
  await fakeDb.collection('plots').insertOne({
    _id: 'main',
    title: '**The Heist**',
    synopsis: 'A crew plans one last job.',
    notes: '',
    beats: [
      {
        _id: beatId,
        name: 'Opening',
        desc: 'The vault.',
        body: '',
        images: [],
        main_image_id: null,
      },
    ],
    current_beat_id: null,
    updated_at: new Date(),
  });
  await fakeDb.collection('prompts').insertMany([
    {
      _id: 'character_template',
      fields: [{ name: 'bio', description: 'Bio', required: false, core: true }],
    },
    {
      _id: 'plot_template',
      synopsis_guidance: 'Keep it short.',
      beat_guidance: 'One scene per beat.',
    },
    {
      _id: 'director_notes',
      notes: [{ _id: new ObjectId(), text: 'More dogs.', images: [] }],
    },
  ]);
  await fakeDb.collection('yjs_docs').insertMany([
    { _id: 'plot', state: 'BIN_PLOT', updated_at: new Date() },
    { _id: 'notes', state: 'BIN_NOTES', updated_at: new Date() },
    { _id: 'library', state: 'BIN_LIBRARY', updated_at: new Date() },
    { _id: entityRoomId, state: 'BIN_BEAT', updated_at: new Date() },
  ]);
  await fakeDb.collection('characters').insertMany([
    { _id: new ObjectId(), name: 'Steve', name_lower: 'steve', fields: {} },
    { _id: new ObjectId(), name: 'Alice', name_lower: 'alice', fields: {} },
  ]);
  await fakeDb.collection('messages').insertMany([
    { _id: new ObjectId(), channel_id: CHANNEL_ID, role: 'user', content: 'hi', created_at: new Date() },
    { _id: new ObjectId(), channel_id: CHANNEL_ID, role: 'assistant', content: 'hello', created_at: new Date() },
  ]);
  await fakeDb.collection('storyboards').insertOne({ _id: new ObjectId(), beat_id: beatId, shots: [] });
  await fakeDb.collection('dialogs').insertOne({ _id: new ObjectId(), beat_id: beatId, lines: [] });
  await fakeDb.collection('images.files').insertOne({
    _id: new ObjectId(),
    filename: 'lib.png',
    length: 3,
    chunkSize: 261120,
    uploadDate: new Date(),
    metadata: { owner_type: null, owner_id: null, source: 'upload', kind: null },
  });
  await fakeDb.collection('attachments.files').insertOne({
    _id: new ObjectId(),
    filename: 'notes.txt',
    length: 3,
    chunkSize: 261120,
    uploadDate: new Date(),
    metadata: { owner_type: 'beat', owner_id: beatId },
  });
}

describe('migrate-multi-project', () => {
  beforeEach(async () => {
    fakeDb.reset();
    await seedLegacy();
  });

  it('creates the default project titled from the stripped plot title', async () => {
    const summary = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(summary.createdProject).toBe(true);
    expect(summary.title).toBe('The Heist');
    const projects = await fakeDb.collection('projects').find({}).toArray();
    expect(projects).toHaveLength(1);
    expect(projects[0].title).toBe('The Heist');
    expect(projects[0].title_lower).toBe('the heist');
    expect(projects[0].created_at).toBeInstanceOf(Date);
    expect(summary.projectId).toBe(projects[0]._id.toString());
  });

  it('stamps project_id on content docs and GridFS metadata', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect((await fakeDb.collection('plots').findOne({ _id: 'main' })).project_id).toBe(projectId);
    for (const c of await fakeDb.collection('characters').find({}).toArray()) {
      expect(c.project_id).toBe(projectId);
    }
    for (const m of await fakeDb.collection('messages').find({}).toArray()) {
      expect(m.project_id).toBe(projectId);
    }
    for (const s of await fakeDb.collection('storyboards').find({}).toArray()) {
      expect(s.project_id).toBe(projectId);
    }
    for (const d of await fakeDb.collection('dialogs').find({}).toArray()) {
      expect(d.project_id).toBe(projectId);
    }
    for (const f of await fakeDb.collection('images.files').find({}).toArray()) {
      expect(f.metadata.project_id).toBe(projectId);
    }
    for (const f of await fakeDb.collection('attachments.files').find({}).toArray()) {
      expect(f.metadata.project_id).toBe(projectId);
    }
  });

  it('re-keys the three prompts singletons to composite ids', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    for (const key of ['character_template', 'plot_template', 'director_notes']) {
      expect(await fakeDb.collection('prompts').findOne({ _id: key })).toBeNull();
      const moved = await fakeDb.collection('prompts').findOne({ _id: `${projectId}:${key}` });
      expect(moved).not.toBeNull();
      expect(moved.project_id).toBe(projectId);
    }
    const tpl = await fakeDb.collection('prompts').findOne({ _id: `${projectId}:character_template` });
    expect(tpl.fields[0].name).toBe('bio');
  });

  it('renames the singleton yjs rooms preserving state and leaves entity rooms alone', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    for (const [room, marker] of [
      ['plot', 'BIN_PLOT'],
      ['notes', 'BIN_NOTES'],
      ['library', 'BIN_LIBRARY'],
    ]) {
      expect(await fakeDb.collection('yjs_docs').findOne({ _id: room })).toBeNull();
      const moved = await fakeDb.collection('yjs_docs').findOne({ _id: `${room}:${projectId}` });
      expect(moved).not.toBeNull();
      expect(moved.state).toBe(marker);
    }
    const beatRoom = await fakeDb.collection('yjs_docs').findOne({ _id: entityRoomId });
    expect(beatRoom.state).toBe('BIN_BEAT');
  });

  it('points channel_state at the default project without clobbering an existing pointer', async () => {
    const { projectId } = await migrate(fakeDb, { channelId: CHANNEL_ID });
    const cs = await fakeDb.collection('channel_state').findOne({ _id: CHANNEL_ID });
    expect(cs.current_project_id).toBe(projectId);
    // Simulate the operator having switched projects, then re-running the migration.
    await fakeDb
      .collection('channel_state')
      .updateOne({ _id: CHANNEL_ID }, { $set: { current_project_id: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
    await migrate(fakeDb, { channelId: CHANNEL_ID });
    const after = await fakeDb.collection('channel_state').findOne({ _id: CHANNEL_ID });
    expect(after.current_project_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('is idempotent: a second run is a no-op on converged state', async () => {
    const first = await migrate(fakeDb, { channelId: CHANNEL_ID });
    const second = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(second.createdProject).toBe(false);
    expect(second.renamedProject).toBe(false);
    expect(second.projectId).toBe(first.projectId);
    expect(second.title).toBe(first.title);
    expect(second.promptsRekeyed).toBe(0);
    expect(second.yjsRenamed).toBe(0);
    for (const count of Object.values(second.stamped)) expect(count).toBe(0);
    expect(await fakeDb.collection('projects').find({}).toArray()).toHaveLength(1);
    expect(await fakeDb.collection('prompts').find({}).toArray()).toHaveLength(3);
    expect(await fakeDb.collection('yjs_docs').find({}).toArray()).toHaveLength(4);
  });

  it('recovers when the NEW code restarted before the migration (startup seeding ran first): adopts + renames the lazy "Screenplay" project and lets legacy templates overwrite the freshly-seeded defaults', async () => {
    // Simulate the wrong deploy order: the restarted bot's first request ran
    // getDefaultProject() (lazily creating a "Screenplay" project) and
    // seedProjectDefaults cloned FRESH default templates for it. The legacy
    // singletons (with the user's customizations) still exist, and the main
    // plot doc is still un-stamped.
    const lazyId = new ObjectId();
    const lazyPid = lazyId.toString();
    await fakeDb.collection('projects').insertOne({
      _id: lazyId,
      title: 'Screenplay',
      title_lower: 'screenplay',
      created_at: new Date(),
    });
    await fakeDb.collection('prompts').insertMany([
      {
        _id: `${lazyPid}:character_template`,
        project_id: lazyPid,
        fields: [{ name: 'fresh_default', description: 'D', required: false, core: true }],
      },
      {
        _id: `${lazyPid}:plot_template`,
        project_id: lazyPid,
        synopsis_guidance: 'fresh default',
        beat_guidance: 'fresh default',
      },
    ]);

    const summary = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(summary.createdProject).toBe(false);
    expect(summary.renamedProject).toBe(true);
    expect(summary.projectId).toBe(lazyPid);
    expect(summary.title).toBe('The Heist');
    const projects = await fakeDb.collection('projects').find({}).toArray();
    expect(projects).toHaveLength(1);
    expect(projects[0].title).toBe('The Heist');
    expect(projects[0].title_lower).toBe('the heist');

    // The user's CUSTOMIZED legacy templates won over the freshly-seeded defaults.
    const tpl = await fakeDb.collection('prompts').findOne({ _id: `${lazyPid}:character_template` });
    expect(tpl.fields.map((f) => f.name)).toContain('bio');
    expect(tpl.fields.map((f) => f.name)).not.toContain('fresh_default');
    const plotTpl = await fakeDb.collection('prompts').findOne({ _id: `${lazyPid}:plot_template` });
    expect(plotTpl.synopsis_guidance).toBe('Keep it short.');
    for (const key of ['character_template', 'plot_template', 'director_notes']) {
      expect(await fakeDb.collection('prompts').findOne({ _id: key })).toBeNull();
    }
    expect(await fakeDb.collection('prompts').find({}).toArray()).toHaveLength(3);

    // Idempotent from the recovered state too.
    const second = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(second.createdProject).toBe(false);
    expect(second.renamedProject).toBe(false);
    expect(second.promptsRekeyed).toBe(0);
    expect(await fakeDb.collection('projects').find({}).toArray()).toHaveLength(1);
  });

  it('falls back to "Screenplay" when there is no plot title', async () => {
    fakeDb.reset(); // empty DB — fresh install path
    const summary = await migrate(fakeDb, { channelId: CHANNEL_ID });
    expect(summary.title).toBe('Screenplay');
    expect(summary.createdProject).toBe(true);
  });
});
