// Tests for the in-memory throttle memo (recentClaims) introduced in Fix A.
// Verifies that once an editor has been announced for a target this window,
// subsequent keystrokes skip the Mongo round-trips entirely.

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

// Intercept claimAnnouncement so we can count how many Mongo round-trips fire.
// Always returns true (claim succeeds) — without the in-memory fast-path the
// second and third keystrokes would each call this and produce three
// announcements.
const claimFn = vi.fn(async () => true);
vi.mock('../src/mongo/editAnnouncements.js', () => ({
  claimAnnouncement: (...args) => claimFn(...args),
}));

const Projects = await import('../src/mongo/projects.js');
const {
  primeRoomCache,
  handleRoomChange,
  _resetCacheForTests,
} = await import('../src/web/editAnnounce.js');

let projectId;
let beatId;

beforeEach(async () => {
  fakeDb.reset();
  announceCalls.length = 0;
  claimFn.mockClear();
  _resetCacheForTests();
  const proj = await Projects.createProject('Film');
  projectId = proj._id.toString();
  beatId = new ObjectId();
  await fakeDb.collection('plots').insertOne({
    _id: new ObjectId(),
    project_id: projectId,
    title: 'Film',
    beats: [
      {
        _id: beatId,
        order: 1,
        name: 'Scene One',
        body: 'old body',
        desc: '',
        images: [],
        attachments: [],
      },
    ],
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
  fields: ['name', 'body', 'desc'],
  seed: { name: 'Scene One', body: 'old body', desc: '' },
});

describe('in-memory throttle fast-path (recentClaims)', () => {
  it('calls announceMediaEvent and claimAnnouncement exactly once across three keystrokes by the same editor', async () => {
    primeRoomCache(beatRoom(), beatDesc());
    const ctx = { user: { name: 'Alice' } };

    // Three successive body changes — simulates keystroke-by-keystroke editing.
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'keystroke 1', desc: '' }),
      context: ctx,
    });
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'keystroke 2', desc: '' }),
      context: ctx,
    });
    await handleRoomChange({
      documentName: beatRoom(),
      document: fakeDoc({ name: 'Scene One', body: 'keystroke 3', desc: '' }),
      context: ctx,
    });

    // Only one announcement should fire — the first one.
    expect(announceCalls).toHaveLength(1);
    // claimAnnouncement (the Mongo call) should be skipped on keystrokes 2 and
    // 3 by the in-memory fast-path.
    expect(claimFn).toHaveBeenCalledTimes(1);
  });
});
