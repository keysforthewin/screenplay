import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const spies = vi.hoisted(() => ({
  listCharacters: vi.fn(async () => []),
  getPlot: vi.fn(async () => ({ _id: 'p', beats: [], current_beat_id: null })),
  searchMessages: vi.fn(async () => ({ results: [], scanned: 0, scan_limit_hit: false })),
}));

vi.mock('../src/mongo/characters.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listCharacters: spies.listCharacters,
}));
vi.mock('../src/mongo/plots.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getPlot: spies.getPlot,
}));
vi.mock('../src/mongo/messages.js', async (importOriginal) => ({
  ...(await importOriginal()),
  searchMessages: spies.searchMessages,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const { beatUrl, characterUrl, notesUrl, libraryUrl } = await import('../src/web/links.js');

const PID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const ctx = { discordUser: null, channelId: 'chan-9', projectId: PID, projectTitle: 'My Movie' };

beforeEach(() => {
  fakeDb.reset();
  spies.listCharacters.mockClear();
  spies.getPlot.mockClear();
  spies.searchMessages.mockClear();
});

describe('handler projectId threading (representative sweep checks)', () => {
  it('list_characters threads context.projectId as first arg', async () => {
    await HANDLERS.list_characters({}, ctx);
    expect(spies.listCharacters).toHaveBeenCalledWith(PID);
  });

  it('get_plot threads context.projectId as first arg', async () => {
    await HANDLERS.get_plot({}, ctx);
    expect(spies.getPlot).toHaveBeenCalledWith(PID);
  });

  it('search_message_history uses context.channelId and the project filter', async () => {
    await HANDLERS.search_message_history({ pattern: 'foo' }, ctx);
    expect(spies.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'chan-9', projectId: PID }),
    );
  });
});

describe('project-prefixed SPA links', () => {
  it('builders prefix /p/<encoded title>', () => {
    expect(beatUrl('My Movie', { order: 2 })).toMatch(/\/p\/My%20Movie\/beat\/2$/);
    expect(characterUrl('My Movie', { name: 'Steve' })).toMatch(
      /\/p\/My%20Movie\/character\/Steve$/,
    );
    expect(notesUrl('My Movie')).toMatch(/\/p\/My%20Movie\/notes$/);
    expect(libraryUrl('My Movie')).toMatch(/\/p\/My%20Movie\/library$/);
  });
});
