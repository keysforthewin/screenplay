import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { ObjectId } from 'mongodb';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

// Stub the JSDOM-heavy markdown renderer: return whatever text the test stashed
// on the fake document for that field.
vi.mock('../src/web/headlessEditor.js', () => ({
  fragmentToMarkdown: (document, field) => document.__fields[field] ?? '',
  setFragmentMarkdown: () => {},
}));

const announceCalls = [];
vi.mock('../src/discord/announcer.js', () => ({
  announceMediaEvent: async (payload) => {
    announceCalls.push(payload);
  },
  announceText: async () => {},
}));

const Projects = await import('../src/mongo/projects.js');
const {
  primeRoomCache,
  forgetRoomCache,
  handleRoomChange,
  maybeAnnounceCast,
  _resetCacheForTests,
} = await import('../src/web/editAnnounce.js');

let projectId;
let beatId;

beforeEach(async () => {
  fakeDb.reset();
  announceCalls.length = 0;
  _resetCacheForTests();
  const proj = await Projects.createProject('Film');
  projectId = proj._id.toString();
  beatId = new ObjectId();
  await fakeDb.collection('plots').insertOne({
    _id: new ObjectId(),
    project_id: projectId,
    title: 'Film',
    beats: [{ _id: beatId, order: 1, name: 'Scene One', body: 'old body', desc: '', images: [], attachments: [] }],
  });
});

function beatRoom() {
  return `beat:${beatId.toString()}`;
}

function fakeDoc(fields) {
  return { __fields: fields };
}

const beatDesc = () => ({
  type: 'beat',
  id: beatId.toString(),
  fields: ['name', 'body', 'desc', 'scene_bible.location'],
  seed: { name: 'Scene One', body: 'old body', desc: '', 'scene_bible.location': '' },
});

describe('handleRoomChange (beat writing edits)', () => {
  it('announces once for a human body edit', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW body', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].verb).toBe('edited the writing in');
    expect(announceCalls[0].username).toBe('Alice');
  });

  it('does not announce a second edit by the same person within the window', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    const ctx = { user: { name: 'Alice' } };
    await handleRoomChange({ documentName: beatRoom(), document: fakeDoc({ name: 'Scene One', body: 'b1', desc: '' }), context: ctx });
    await handleRoomChange({ documentName: beatRoom(), document: fakeDoc({ name: 'Scene One', body: 'b2', desc: '' }), context: ctx });
    expect(announceCalls).toHaveLength(1);
  });

  it('never announces bot edits', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'bot wrote this', desc: '' }),
      context: { actor: 'bot' },
    });
    expect(announceCalls).toHaveLength(0);
  });

  it('does not announce when only a non-announce field changed', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      // body/name/desc unchanged vs seed; scene_bible isn't an announce field
      document: fakeDoc({ name: 'Scene One', body: 'old body', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    expect(announceCalls).toHaveLength(0);
  });

  it('forgetRoomCache makes a later change a no-op (room not primed)', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    forgetRoomCache(beatRoom());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    expect(announceCalls).toHaveLength(0);
  });
});

describe('maybeAnnounceCast', () => {
  it('announces a cast add once, then throttles the same editor on that beat', async () => {
    const beat = { _id: beatId, order: 1, name: 'Scene One' };
    await maybeAnnounceCast({ projectId, projectTitle: 'Film', beat, editor: 'Alice', added: ['Mary'], removed: [] });
    await maybeAnnounceCast({ projectId, projectTitle: 'Film', beat, editor: 'Alice', added: ['Bob'], removed: [] });
    expect(announceCalls).toHaveLength(1);
    expect(announceCalls[0].verb).toBe('added Mary to');
  });

  it('shares the beat bucket with writing edits (writing first → cast suppressed)', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'NEW', desc: '' }),
      context: { user: { name: 'Alice' } },
    });
    const beat = { _id: beatId, order: 1, name: 'Scene One' };
    await maybeAnnounceCast({ projectId, projectTitle: 'Film', beat, editor: 'Alice', added: ['Mary'], removed: [] });
    expect(announceCalls).toHaveLength(1); // only the writing edit
  });
});
