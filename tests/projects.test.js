import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Projects = await import('../src/mongo/projects.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('createProject', () => {
  it('creates a project with trimmed title, title_lower, created_at', async () => {
    const p = await Projects.createProject('  My Movie  ');
    expect(p._id).toBeInstanceOf(ObjectId);
    expect(p.title).toBe('My Movie');
    expect(p.title_lower).toBe('my movie');
    expect(p.created_at).toBeInstanceOf(Date);
  });

  it('rejects empty / whitespace-only titles', async () => {
    await expect(Projects.createProject('')).rejects.toThrow(/non-empty/);
    await expect(Projects.createProject('   ')).rejects.toThrow(/non-empty/);
    await expect(Projects.createProject(undefined)).rejects.toThrow(/non-empty/);
  });

  it('rejects titles longer than 120 chars', async () => {
    await expect(Projects.createProject('x'.repeat(121))).rejects.toThrow(/120/);
  });

  it('rejects titles containing "/"', async () => {
    await expect(Projects.createProject('a/b')).rejects.toThrow(/\//);
  });

  it('rejects "." and ".." as titles', async () => {
    await expect(Projects.createProject('.')).rejects.toThrow(/title/);
    await expect(Projects.createProject('..')).rejects.toThrow(/title/);
  });

  it('throws (code 11000) on duplicate title, case-insensitively', async () => {
    await Projects.createProject('Heist');
    const err = await Projects.createProject('  HEIST ').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(11000);
    expect(err.message).toMatch(/duplicate/i);
  });
});

describe('listProjects / getProjectByTitle / getProjectById', () => {
  it('listProjects returns all projects oldest-first', async () => {
    const a = await Projects.createProject('A');
    const b = await Projects.createProject('B');
    const list = await Projects.listProjects();
    expect(list.map((p) => p.title)).toEqual(['A', 'B']);
    expect(list[0]._id.toString()).toBe(a._id.toString());
    expect(list[1]._id.toString()).toBe(b._id.toString());
  });

  it('getProjectByTitle is case-insensitive and trims', async () => {
    const p = await Projects.createProject('Space Western');
    const found = await Projects.getProjectByTitle('  space WESTERN ');
    expect(found._id.toString()).toBe(p._id.toString());
    expect(await Projects.getProjectByTitle('nope')).toBe(null);
  });

  it('getProjectById accepts hex string or ObjectId; bad input returns null', async () => {
    const p = await Projects.createProject('X');
    expect((await Projects.getProjectById(p._id.toString()))._id.toString()).toBe(p._id.toString());
    expect((await Projects.getProjectById(p._id))._id.toString()).toBe(p._id.toString());
    expect(await Projects.getProjectById('not-hex')).toBe(null);
    expect(await Projects.getProjectById(new ObjectId().toString())).toBe(null);
  });
});

describe('getDefaultProject', () => {
  it('lazily creates a project titled "Screenplay" when the collection is empty', async () => {
    const def = await Projects.getDefaultProject();
    expect(def.title).toBe('Screenplay');
    expect(fakeDb.collection('projects')._docs).toHaveLength(1);
    // Idempotent: second call returns the same doc, no second insert.
    const again = await Projects.getDefaultProject();
    expect(again._id.toString()).toBe(def._id.toString());
    expect(fakeDb.collection('projects')._docs).toHaveLength(1);
  });

  it('returns the oldest project by created_at when projects exist', async () => {
    const a = await Projects.createProject('First');
    await Projects.createProject('Second');
    const def = await Projects.getDefaultProject();
    expect(def._id.toString()).toBe(a._id.toString());
  });
});

describe('resolveProjectId (strict)', () => {
  it('accepts a 24-hex string or an ObjectId', async () => {
    const oid = new ObjectId();
    expect(await Projects.resolveProjectId(oid)).toBe(oid.toString());
    const hex = oid.toString();
    expect(await Projects.resolveProjectId(hex)).toBe(hex);
  });

  it('rejects a truthy but malformed id', async () => {
    await expect(Projects.resolveProjectId('abc')).rejects.toThrow(/invalid projectId/);
  });

  it('resolveProjectId throws on a falsy projectId (strict mode)', async () => {
    await expect(Projects.resolveProjectId(undefined)).rejects.toThrow(/projectId required/);
    await expect(Projects.resolveProjectId(null)).rejects.toThrow(/projectId required/);
    await expect(Projects.resolveProjectId('')).rejects.toThrow(/projectId required/);
  });

  it('resolveProjectId stringifies truthy ids', async () => {
    const project = await Projects.createProject('Stringify Me');
    expect(await Projects.resolveProjectId(project._id)).toBe(project._id.toString());
    expect(await Projects.resolveProjectId(project._id.toString())).toBe(project._id.toString());
  });
});
