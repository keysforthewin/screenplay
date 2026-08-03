// Per-project authorization (src/web/permissions.js): the ADMIN_USERNAME
// master switch, admin detection, grant checks, the requireProjectAccess /
// requireAdmin middlewares (stub req/res, no HTTP server), and the Hocuspocus
// assertRoomAccess helper.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({}));

const Permissions = await import('../src/web/permissions.js');
const Users = await import('../src/mongo/users.js');
const Projects = await import('../src/mongo/projects.js');

function stubRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function grant(name, projectIds) {
  const user = await Users.findOrCreateUserByName(name);
  await Users.setUserProjects(user._id.toString(), projectIds);
  return user;
}

describe('permissions', () => {
  beforeEach(() => {
    fakeDb.reset();
    process.env.ADMIN_USERNAME = 'Boss';
  });
  afterEach(() => {
    process.env.ADMIN_USERNAME = '';
  });

  it('permissionsEnabled tracks the env var live', () => {
    expect(Permissions.permissionsEnabled()).toBe(true);
    process.env.ADMIN_USERNAME = '';
    expect(Permissions.permissionsEnabled()).toBe(false);
  });

  it('isAdmin matches case-insensitively with trimming, never when disabled', () => {
    expect(Permissions.isAdmin('Boss')).toBe(true);
    expect(Permissions.isAdmin('  bOsS ')).toBe(true);
    expect(Permissions.isAdmin('Member')).toBe(false);
    expect(Permissions.isAdmin('')).toBe(false);
    expect(Permissions.isAdmin(null)).toBe(false);
    process.env.ADMIN_USERNAME = '';
    expect(Permissions.isAdmin('Boss')).toBe(false);
  });

  it('canAccessProject: disabled→true, admin→true, member by grant, stranger→false', async () => {
    const p = await Projects.createProject('Western');
    const pid = p._id.toString();
    await grant('Member', [pid]);
    expect(await Permissions.canAccessProject('Boss', pid)).toBe(true);
    expect(await Permissions.canAccessProject('member', pid)).toBe(true);
    expect(await Permissions.canAccessProject('Stranger', pid)).toBe(false);
    expect(await Permissions.canAccessProject(null, pid)).toBe(false);
    process.env.ADMIN_USERNAME = '';
    expect(await Permissions.canAccessProject('Stranger', pid)).toBe(true);
  });

  it('listProjectsFor filters to grants; admin and disabled mode see all; unknown user sees none', async () => {
    const a = await Projects.createProject('A');
    await Projects.createProject('B');
    await grant('Member', [a._id.toString()]);
    expect((await Permissions.listProjectsFor('Boss')).map((p) => p.title)).toEqual(['A', 'B']);
    expect((await Permissions.listProjectsFor('Member')).map((p) => p.title)).toEqual(['A']);
    expect(await Permissions.listProjectsFor('Stranger')).toEqual([]);
    expect(await Permissions.listProjectsFor(null)).toEqual([]);
    process.env.ADMIN_USERNAME = '';
    expect((await Permissions.listProjectsFor('Stranger')).map((p) => p.title)).toEqual(['A', 'B']);
  });

  describe('requireProjectAccess middleware', () => {
    it('passes members, 403s strangers', async () => {
      const p = await Projects.createProject('Western');
      const pid = p._id.toString();
      await grant('Member', [pid]);

      const mw = Permissions.requireProjectAccess();
      let next = vi.fn();
      await mw({ projectId: pid, session: { username: 'Member' } }, stubRes(), next);
      expect(next).toHaveBeenCalledOnce();

      next = vi.fn();
      const res = stubRes();
      await mw({ projectId: pid, session: { username: 'Stranger' } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden project' });
    });

    it('passes the admin and no-ops without req.projectId or when disabled', async () => {
      const p = await Projects.createProject('Western');
      const pid = p._id.toString();
      const mw = Permissions.requireProjectAccess();

      let next = vi.fn();
      await mw({ projectId: pid, session: { username: 'boss' } }, stubRes(), next);
      expect(next).toHaveBeenCalledOnce();

      // No projectId (the exempted /projects* and /admin* paths).
      next = vi.fn();
      await mw({ session: { username: 'Stranger' } }, stubRes(), next);
      expect(next).toHaveBeenCalledOnce();

      // Missing session (mocked-requireSession test traffic) fails closed.
      next = vi.fn();
      const res = stubRes();
      await mw({ projectId: pid }, res, next);
      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();

      process.env.ADMIN_USERNAME = '';
      next = vi.fn();
      await mw({ projectId: pid }, stubRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('requireAdmin middleware', () => {
    it('passes admin, 403s everyone else, no-ops when disabled', () => {
      const mw = Permissions.requireAdmin();

      let next = vi.fn();
      mw({ session: { username: 'BOSS' } }, stubRes(), next);
      expect(next).toHaveBeenCalledOnce();

      next = vi.fn();
      const res = stubRes();
      mw({ session: { username: 'Member' } }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'admin only' });

      next = vi.fn();
      mw({}, stubRes(), next);
      expect(next).not.toHaveBeenCalled();

      process.env.ADMIN_USERNAME = '';
      next = vi.fn();
      mw({ session: { username: 'Member' } }, stubRes(), next);
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('assertRoomAccess', () => {
    it('allows granted singleton rooms, rejects ungranted ones, admin passes everywhere', async () => {
      const p = await Projects.createProject('Western');
      const pid = p._id.toString();
      await grant('Member', [pid]);
      const other = await Projects.createProject('Other');

      await expect(Permissions.assertRoomAccess('Member', `plot:${pid}`)).resolves.toBeUndefined();
      await expect(
        Permissions.assertRoomAccess('Member', `plot:${other._id.toString()}`),
      ).rejects.toThrow(/forbidden room/);
      await expect(
        Permissions.assertRoomAccess('Boss', `plot:${other._id.toString()}`),
      ).resolves.toBeUndefined();
    });

    it('resolves entity rooms through the owning beat/character', async () => {
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
      await grant('Member', [pid]);

      for (const room of [
        `beat:${beatId.toString()}`,
        `storyboards:${beatId.toString()}`,
        `dialogs:${beatId.toString()}`,
        `character:${charId.toString()}`,
      ]) {
        await expect(Permissions.assertRoomAccess('Member', room)).resolves.toBeUndefined();
        await expect(Permissions.assertRoomAccess('Stranger', room)).rejects.toThrow(
          /forbidden room/,
        );
      }
    });

    it('rejects unparseable rooms and unknown entities, no-ops when disabled', async () => {
      await expect(Permissions.assertRoomAccess('Member', 'garbage')).rejects.toThrow(
        /forbidden room/,
      );
      await expect(
        Permissions.assertRoomAccess('Member', `beat:${new ObjectId().toString()}`),
      ).rejects.toThrow(/forbidden room/);
      process.env.ADMIN_USERNAME = '';
      await expect(Permissions.assertRoomAccess('Member', 'garbage')).resolves.toBeUndefined();
    });
  });
});
