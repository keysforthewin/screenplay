import { describe, it, expect, beforeEach, vi } from 'vitest';
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

const { createProject } = await import('../src/mongo/projects.js');
const { resolveRoom, parseRoomName, buildRoomName } = await import('../src/web/roomRegistry.js');
const Plots = await import('../src/mongo/plots.js');
const Projects = await import('../src/mongo/projects.js');

async function pid() {
  return (await Projects.getDefaultProject())._id.toString();
}

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

describe('plot room', () => {
  it('parseRoomName recognizes the project-scoped "plot" room', async () => {
    const p = await pid();
    expect(parseRoomName(`plot:${p}`)).toEqual({ type: 'plot', projectId: p });
    expect(parseRoomName('plot')).toBeNull();
  });

  it('buildRoomName returns "plot:<pid>" for type:plot', async () => {
    const p = await pid();
    expect(buildRoomName('plot', p)).toBe(`plot:${p}`);
  });

  it('describePlotRoom exposes title/synopsis/dialogue_style seeded from Mongo', async () => {
    await Plots.updatePlot(projectId, {
      title: 'Neon City',
      synopsis: 'A detective hunts a ghost.',
      dialogue_style: '1970s neo-noir.',
    });

    const desc = await resolveRoom(`plot:${await pid()}`);
    expect(desc.type).toBe('plot');
    expect(desc.fields).toEqual(['title', 'synopsis', 'dialogue_style']);
    expect(desc.seed.title).toBe('Neon City');
    expect(desc.seed.synopsis).toBe('A detective hunts a ghost.');
    expect(desc.seed.dialogue_style).toBe('1970s neo-noir.');
  });

  it('persistFields writes only changed fields back to Mongo', async () => {
    await Plots.updatePlot(projectId, { title: 'Old', synopsis: 'keep', dialogue_style: 'keep too' });

    const desc = await resolveRoom(`plot:${await pid()}`);
    const result = await desc.persistFields({
      title: 'New Title',
      synopsis: 'keep', // unchanged
      dialogue_style: 'keep too', // unchanged
    });
    expect(result.changed).toBe(true);
    expect(result.fields).toEqual(['title']);

    const plot = await Plots.getPlot(projectId);
    expect(plot.title).toBe('New Title');
    expect(plot.synopsis).toBe('keep');
  });

  it('persistFields is a no-op when nothing changed', async () => {
    await Plots.updatePlot(projectId, { title: 'Same', synopsis: 'same', dialogue_style: 'same' });
    const desc = await resolveRoom(`plot:${await pid()}`);
    const result = await desc.persistFields({
      title: 'Same',
      synopsis: 'same',
      dialogue_style: 'same',
    });
    expect(result.changed).toBe(false);
  });
});
