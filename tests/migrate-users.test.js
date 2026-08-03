// scripts/migrate-users.js — grandfather existing sessions into users docs.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
  closeMongo: async () => {},
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { migrateUsers } = await import('../scripts/migrate-users.js');

let projectA;
let projectB;

beforeEach(async () => {
  fakeDb.reset();
  projectA = new ObjectId();
  projectB = new ObjectId();
  await fakeDb.collection('projects').insertMany([
    { _id: projectA, title: 'A', title_lower: 'a', created_at: new Date(1) },
    { _id: projectB, title: 'B', title_lower: 'b', created_at: new Date(2) },
  ]);
});

function session(username, createdAtMs, extra = {}) {
  return {
    session_id: `sess_${Math.random().toString(36).slice(2)}`,
    username,
    created_at: new Date(createdAtMs),
    last_seen: new Date(createdAtMs),
    ...extra,
  };
}

describe('migrateUsers', () => {
  it('creates one user per distinct name with ALL projects granted, links sessions', async () => {
    await fakeDb.collection('auth_sessions').insertMany([
      session('Steve', 1000),
      session('Bob', 2000),
    ]);

    const summary = await migrateUsers(fakeDb);
    expect(summary).toEqual({ users_created: 2, sessions_linked: 2, users_existing: 0 });

    const users = await fakeDb.collection('users').find({}).toArray();
    expect(users.map((u) => u.name).sort()).toEqual(['Bob', 'Steve']);
    for (const u of users) {
      expect(u.project_ids.sort()).toEqual(
        [projectA.toString(), projectB.toString()].sort(),
      );
    }
    const sessions = await fakeDb.collection('auth_sessions').find({}).toArray();
    for (const s of sessions) expect(s.user_id).toBeTruthy();
  });

  it('dedupes casings into one user using first-seen display casing, links all casings', async () => {
    await fakeDb.collection('auth_sessions').insertMany([
      session('sTEVE', 2000),
      session('Steve', 1000),
      session('STEVE', 3000),
    ]);

    const summary = await migrateUsers(fakeDb);
    expect(summary.users_created).toBe(1);
    expect(summary.sessions_linked).toBe(3);

    const users = await fakeDb.collection('users').find({}).toArray();
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('Steve');
    const uid = users[0]._id;
    for (const s of await fakeDb.collection('auth_sessions').find({}).toArray()) {
      expect(String(s.user_id)).toBe(String(uid));
    }
  });

  it('is idempotent and never re-widens a narrowed grant set', async () => {
    await fakeDb.collection('auth_sessions').insertMany([session('Steve', 1000)]);
    await migrateUsers(fakeDb);

    // Admin narrows Steve to project A only.
    await fakeDb
      .collection('users')
      .updateOne({ name_lower: 'steve' }, { $set: { project_ids: [projectA.toString()] } });

    const rerun = await migrateUsers(fakeDb);
    expect(rerun).toEqual({ users_created: 0, sessions_linked: 0, users_existing: 1 });
    const user = await fakeDb.collection('users').findOne({ name_lower: 'steve' });
    expect(user.project_ids).toEqual([projectA.toString()]);
  });

  it('links new unlinked sessions of an existing user on re-run', async () => {
    await fakeDb.collection('auth_sessions').insertMany([session('Steve', 1000)]);
    await migrateUsers(fakeDb);
    // A new device session was approved by the OLD code (no user_id).
    await fakeDb.collection('auth_sessions').insertMany([session('Steve', 5000)]);

    const rerun = await migrateUsers(fakeDb);
    expect(rerun.sessions_linked).toBe(1);
    const user = await fakeDb.collection('users').findOne({ name_lower: 'steve' });
    for (const s of await fakeDb.collection('auth_sessions').find({}).toArray()) {
      expect(String(s.user_id)).toBe(String(user._id));
    }
  });

  it('skips blank usernames and handles an empty database', async () => {
    await fakeDb.collection('auth_sessions').insertMany([session('   ', 1000)]);
    const summary = await migrateUsers(fakeDb);
    expect(summary).toEqual({ users_created: 0, sessions_linked: 0, users_existing: 0 });
  });
});
