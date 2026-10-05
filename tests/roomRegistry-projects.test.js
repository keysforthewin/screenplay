// Project-scoped singleton rooms (notes/library/plot become notes:<projectId>
// etc.), entity rooms unchanged, and project verification for room access.
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
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({}));

const { buildRoomName, parseRoomName, resolveRoom, assertRoomProjectKnown, projectIdForRoom } =
  await import('../src/web/roomRegistry.js');
const Projects = await import('../src/mongo/projects.js');
const DirectorNotes = await import('../src/mongo/directorNotes.js');

beforeEach(() => fakeDb.reset());

describe('project-scoped room names', () => {
  it('buildRoomName/parseRoomName round-trip the three singleton rooms', () => {
    const pid = new ObjectId().toString();
    for (const type of ['notes', 'library', 'plot']) {
      const name = buildRoomName(type, pid);
      expect(name).toBe(`${type}:${pid}`);
      expect(parseRoomName(name)).toEqual({ type, projectId: pid });
    }
  });

  it('bare legacy singleton names are no longer managed rooms', () => {
    expect(parseRoomName('notes')).toBeNull();
    expect(parseRoomName('library')).toBeNull();
    expect(parseRoomName('plot')).toBeNull();
  });

  it('buildRoomName throws for a singleton room without a valid project id', () => {
    expect(() => buildRoomName('notes')).toThrow(/project/i);
    expect(() => buildRoomName('library', 'not-hex')).toThrow(/project/i);
  });

  it('entity rooms are unchanged', () => {
    const id = new ObjectId().toString();
    expect(buildRoomName('beat', id)).toBe(`beat:${id}`);
    expect(parseRoomName(`character:${id}`)).toEqual({ type: 'character', id });
    expect(parseRoomName(`dialogs:${id}`)).toEqual({ type: 'dialogs', id });
    // The retired storyboards room no longer parses.
    expect(parseRoomName(`storyboards:${id}`)).toBeNull();
    expect(parseRoomName(`video_prompts:${id}`)).toEqual({ type: 'video_prompts', id });
    expect(buildRoomName('video_prompts', id)).toBe(`video_prompts:${id}`);
  });

  it('assertRoomProjectKnown accepts known projects and rejects unknown ones', async () => {
    const p = await Projects.createProject('Western');
    await expect(
      assertRoomProjectKnown(`notes:${p._id.toString()}`),
    ).resolves.toMatchObject({ type: 'notes', projectId: p._id.toString() });
    await expect(
      assertRoomProjectKnown(`notes:${new ObjectId().toString()}`),
    ).rejects.toThrow(/unknown project/i);
    await expect(assertRoomProjectKnown('garbage-room')).rejects.toThrow(/unknown room/i);
  });

  it('projectIdForRoom resolves the owning project for every room type', async () => {
    const p = await Projects.createProject('Western');
    const pid = p._id.toString();
    const beatId = new ObjectId();
    const charId = new ObjectId();
    await fakeDb.collection('plots').insertOne({
      _id: new ObjectId(),
      project_id: pid,
      beats: [{ _id: beatId, name: 'B1' }],
    });
    await fakeDb.collection('characters').insertOne({
      _id: charId,
      project_id: pid,
      name: 'Steve',
      name_lower: 'steve',
    });

    for (const room of ['plot', 'notes', 'library'].map((t) => `${t}:${pid}`)) {
      expect(await projectIdForRoom(room)).toBe(pid);
    }
    expect(await projectIdForRoom(`beat:${beatId.toString()}`)).toBe(pid);
    expect(await projectIdForRoom(`dialogs:${beatId.toString()}`)).toBe(pid);
    expect(await projectIdForRoom(`video_prompts:${beatId.toString()}`)).toBe(pid);
    expect(await projectIdForRoom(`character:${charId.toString()}`)).toBe(pid);
    // Unparseable rooms and unknown entities resolve to null.
    expect(await projectIdForRoom('garbage')).toBeNull();
    expect(await projectIdForRoom(`beat:${new ObjectId().toString()}`)).toBeNull();
    expect(await projectIdForRoom(`character:${new ObjectId().toString()}`)).toBeNull();
  });

  it('video_prompts rooms expose scene:<id>:title and item:<id>:title|prompt|start_frame_prompt|end_frame_prompt fragments and persist them', async () => {
    const p = await Projects.createProject('Western');
    const pid = p._id.toString();
    const Plots = await import('../src/mongo/plots.js');
    const VP = await import('../src/mongo/videoPrompts.js');
    const VS = await import('../src/mongo/videoScenes.js');
    const beat = await Plots.createBeat({ projectId: pid, name: 'B1' });
    const scene = await VS.createVideoScene({ projectId: pid, beatId: beat._id, title: 'S' });
    const row = await VP.createVideoPrompt({
      projectId: pid,
      beatId: beat._id,
      sceneId: scene._id,
      title: 'T',
      prompt: 'P',
      endFrame: { prompt: 'E' },
    });
    const desc = await resolveRoom(`video_prompts:${beat._id.toString()}`);
    expect(desc.type).toBe('video_prompts');
    const id = row._id.toString();
    const sid = scene._id.toString();
    expect(desc.fields).toEqual([
      `scene:${sid}:title`,
      `item:${id}:title`,
      `item:${id}:prompt`,
      `item:${id}:start_frame_prompt`,
      `item:${id}:end_frame_prompt`,
    ]);
    expect(desc.fields.some((f) => f.includes('floor_plan'))).toBe(false);
    expect(desc.seed).toEqual({
      [`scene:${sid}:title`]: 'S',
      [`item:${id}:title`]: 'T',
      [`item:${id}:prompt`]: 'P',
      [`item:${id}:start_frame_prompt`]: '',
      [`item:${id}:end_frame_prompt`]: 'E',
    });
    const result = await desc.persistFields({
      [`scene:${sid}:title`]: 'S',
      [`item:${id}:title`]: 'T',
      [`item:${id}:prompt`]: 'P2',
      [`item:${id}:start_frame_prompt`]: 'First frame.',
      [`item:${id}:end_frame_prompt`]: 'E',
    });
    expect(result).toEqual({ changed: true, fields: [`item:${id}:prompt`, `item:${id}:start_frame_prompt`] });
    const stored = await VP.getVideoPrompt(pid, id);
    expect(stored.prompt).toBe('P2');
    expect(stored.start_frame.prompt).toBe('First frame.');
    expect(stored.end_frame.prompt).toBe('E');
    expect(await resolveRoom(`video_prompts:${new ObjectId().toString()}`)).toBeNull();
  });

  it('a scene:<id>:title fragment persists to the video_scenes row; unknown fragments and unchanged text are ignored', async () => {
    const p = await Projects.createProject('Western');
    const pid = p._id.toString();
    const Plots = await import('../src/mongo/plots.js');
    const VS = await import('../src/mongo/videoScenes.js');
    const beat = await Plots.createBeat({ projectId: pid, name: 'B1' });
    const one = await VS.createVideoScene({ projectId: pid, beatId: beat._id, title: 'One' });
    const two = await VS.createVideoScene({ projectId: pid, beatId: beat._id });
    const desc = await resolveRoom(`video_prompts:${beat._id.toString()}`);
    expect(desc.fields).toEqual([`scene:${one._id}:title`, `scene:${two._id}:title`]);
    expect(desc.seed).toEqual({ [`scene:${one._id}:title`]: 'One', [`scene:${two._id}:title`]: '' });
    expect(await desc.persistFields({ [`scene:${one._id}:title`]: 'One', [`scene:${two._id}:title`]: '' })).toEqual({
      changed: false,
    });
    const result = await desc.persistFields({
      [`scene:${one._id}:title`]: 'The **diner**',
      [`scene:${two._id}:title`]: '',
      // The retired floor-plan fragment, a scene that is not in this room, and junk.
      [`scene:${one._id}:floor_plan`]: 'Door at the far end.',
      [`scene:${new ObjectId()}:title`]: 'ghost',
      bogus: 'x',
    });
    expect(result).toEqual({ changed: true, fields: [`scene:${one._id}:title`] });
    const scenes = await VS.listVideoScenes({ projectId: pid, beatId: beat._id });
    expect(scenes.map((s) => s.title)).toEqual(['The **diner**', '']);
    expect(fakeDb.collection('video_scenes')._docs[0]).not.toHaveProperty('floor_plan');
  });

  it('resolveRoom returns null for a singleton room of an unknown project', async () => {
    expect(await resolveRoom(`library:${new ObjectId().toString()}`)).toBeNull();
    expect(await resolveRoom(`notes:${new ObjectId().toString()}`)).toBeNull();
    expect(await resolveRoom(`plot:${new ObjectId().toString()}`)).toBeNull();
  });

  it('notes rooms are independent per project and persist to the composite prompts _id', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const aid = a._id.toString();
    const bid = b._id.toString();
    const noteA = await DirectorNotes.addDirectorNote({ projectId: aid, text: 'alpha' });

    const descA = await resolveRoom(`notes:${aid}`);
    expect(descA.fields).toEqual([`note:${noteA._id.toString()}:text`]);
    const descB = await resolveRoom(`notes:${bid}`);
    expect(descB.fields).toEqual([]);

    const result = await descA.persistFields({
      [`note:${noteA._id.toString()}:text`]: 'alpha v2',
    });
    expect(result.changed).toBe(true);
    expect((await DirectorNotes.getDirectorNotes(aid)).notes[0].text).toBe('alpha v2');
    expect((await DirectorNotes.getDirectorNotes(bid)).notes || []).toHaveLength(0);
    // The write landed on the composite-keyed doc, not the legacy singleton.
    const prompts = fakeDb.collection('prompts')._docs;
    expect(prompts.some((d) => d._id === `${aid}:director_notes`)).toBe(true);
    expect(prompts.some((d) => d._id === 'director_notes')).toBe(false);
  });
});
