// resolvePageContextNote turns the SPA's { kind, ref } page descriptor into a
// short authoritative note injected into the web chat agent turn. Entity kinds
// resolve against live Mongo (here: the in-memory fake); a ref that no longer
// resolves yields null so the caller omits the block.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const Projects = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const { resolvePageContextNote } = await import('../src/web/pageContext.js');

let pid;
beforeEach(async () => {
  fakeDb.reset();
  const project = await Projects.createProject('Western');
  pid = project._id.toString();
  await Plots.createBeat({ projectId: pid, name: 'The Heist', desc: 'heist', body: 'rob bank', order: 2 });
  await Characters.createCharacter({ projectId: pid, name: 'Steve' });
});

const resolve = (context) => resolvePageContextNote({ projectId: pid, projectTitle: 'Western', context });

describe('resolvePageContextNote', () => {
  it('resolves a beat by order to a note with name + id', async () => {
    const note = await resolve({ kind: 'beat', ref: '2' });
    expect(note).toContain('authoritative location');
    expect(note).toContain('Beat 2 — "The Heist"');
    expect(note).toContain('beat id');
  });

  it('phrases storyboard/dialog pages relative to their beat', async () => {
    expect(await resolve({ kind: 'storyboard', ref: '2' })).toContain('storyboard page for Beat 2');
    expect(await resolve({ kind: 'dialog', ref: '2' })).toContain('dialog page for Beat 2');
  });

  it('resolves a character by name', async () => {
    const note = await resolve({ kind: 'character', ref: 'Steve' });
    expect(note).toContain('the character "Steve"');
    expect(note).toContain('character id');
  });

  it('returns static notes for section pages', async () => {
    expect(await resolve({ kind: 'overview' })).toContain('overview for the screenplay "Western"');
    expect(await resolve({ kind: 'about' })).toContain('title, synopsis, dialogue style');
    expect(await resolve({ kind: 'notes' })).toContain("director's notes");
    expect(await resolve({ kind: 'library' })).toContain('media library');
    expect(await resolve({ kind: 'storyboard-index' })).toContain('storyboard index');
    expect(await resolve({ kind: 'dialog-index' })).toContain('dialog index');
  });

  it('returns null for a stale entity ref, an unknown kind, or a missing project', async () => {
    expect(await resolve({ kind: 'beat', ref: '99' })).toBeNull();
    expect(await resolve({ kind: 'bogus' })).toBeNull();
    expect(await resolvePageContextNote({ projectId: null, projectTitle: 'X', context: { kind: 'overview' } })).toBeNull();
    expect(await resolvePageContextNote({ projectId: pid, projectTitle: 'X', context: null })).toBeNull();
  });
});
