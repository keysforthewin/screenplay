import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const Users = await import('../src/mongo/users.js');

const PID_A = 'a'.repeat(24);
const PID_B = 'b'.repeat(24);

describe('users collection', () => {
  beforeEach(() => fakeDb.reset());

  it('findOrCreateUserByName creates a user with empty grants', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    expect(user.name).toBe('Steve');
    expect(user.name_lower).toBe('steve');
    expect(user.project_ids).toEqual([]);
    expect(user.created_at instanceof Date).toBe(true);
  });

  it('same name in a different casing resolves to the same user, keeping first-seen display casing', async () => {
    const first = await Users.findOrCreateUserByName('Steve');
    const second = await Users.findOrCreateUserByName('steve');
    const third = await Users.findOrCreateUserByName('  STEVE  ');
    expect(String(second._id)).toBe(String(first._id));
    expect(String(third._id)).toBe(String(first._id));
    expect(second.name).toBe('Steve');
    expect((await Users.listUsers()).length).toBe(1);
  });

  it('rejects empty names', async () => {
    await expect(Users.findOrCreateUserByName('   ')).rejects.toThrow(/non-empty/);
  });

  it('findUserByName is case-insensitive and null-safe', async () => {
    await Users.findOrCreateUserByName('Steve');
    expect((await Users.findUserByName('sTeVe')).name).toBe('Steve');
    expect(await Users.findUserByName('nobody')).toBeNull();
    expect(await Users.findUserByName('')).toBeNull();
    expect(await Users.findUserByName(null)).toBeNull();
  });

  it('getUserById accepts hex strings and rejects garbage', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    expect(String((await Users.getUserById(user._id.toString()))._id)).toBe(String(user._id));
    expect(await Users.getUserById('not-hex')).toBeNull();
    expect(await Users.getUserById(null)).toBeNull();
  });

  it('setUserProjects replaces the whole set (set semantics) and dedupes', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    let updated = await Users.setUserProjects(user._id.toString(), [PID_A, PID_B, PID_A], {
      grantedBy: 'pal#0001',
    });
    expect(updated.project_ids).toEqual([PID_A, PID_B]);
    expect(updated.last_granted_by).toBe('pal#0001');
    updated = await Users.setUserProjects(user._id.toString(), [PID_B]);
    expect(updated.project_ids).toEqual([PID_B]);
    updated = await Users.setUserProjects(user._id.toString(), []);
    expect(updated.project_ids).toEqual([]);
  });

  it('setUserProjects rejects invalid ids and unknown users', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    await expect(Users.setUserProjects(user._id.toString(), ['nope'])).rejects.toThrow(
      /invalid project id/,
    );
    await expect(Users.setUserProjects(user._id.toString(), 'not-array')).rejects.toThrow(
      /must be an array/,
    );
    expect(await Users.setUserProjects('f'.repeat(24), [PID_A])).toBeNull();
  });

  it('userHasProject checks membership case-insensitively on the name', async () => {
    const user = await Users.findOrCreateUserByName('Steve');
    await Users.setUserProjects(user._id.toString(), [PID_A]);
    expect(await Users.userHasProject('steve', PID_A)).toBe(true);
    expect(await Users.userHasProject('Steve', PID_B)).toBe(false);
    expect(await Users.userHasProject('nobody', PID_A)).toBe(false);
  });

  it('removeProjectFromUsers pulls the id from every user', async () => {
    const a = await Users.findOrCreateUserByName('Alice');
    const b = await Users.findOrCreateUserByName('Bob');
    await Users.setUserProjects(a._id.toString(), [PID_A, PID_B]);
    await Users.setUserProjects(b._id.toString(), [PID_A]);
    await Users.removeProjectFromUsers(PID_A);
    expect((await Users.findUserByName('Alice')).project_ids).toEqual([PID_B]);
    expect((await Users.findUserByName('Bob')).project_ids).toEqual([]);
  });

  it('listUsers sorts by name_lower', async () => {
    await Users.findOrCreateUserByName('zoe');
    await Users.findOrCreateUserByName('Alice');
    const names = (await Users.listUsers()).map((u) => u.name);
    expect(names).toEqual(['Alice', 'zoe']);
  });
});
