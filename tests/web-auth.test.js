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

const Auth = await import('../src/mongo/auth.js');
const Users = await import('../src/mongo/users.js');

describe('auth_requests / auth_sessions', () => {
  beforeEach(() => fakeDb.reset());

  it('creates a request with pending status and an expiration timestamp', async () => {
    const req = await Auth.createAuthRequest({ username: 'Steve', ttlMs: 60_000 });
    expect(req.request_id).toMatch(/^req_/);
    expect(req.username).toBe('Steve');
    expect(req.status).toBe('pending');
    expect(req.expires_at instanceof Date).toBe(true);
    expect(req.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('approveAuthRequest issues a session and marks the request approved', async () => {
    const req = await Auth.createAuthRequest({ username: 'Steve', ttlMs: 60_000 });
    const out = await Auth.approveAuthRequest({
      requestId: req.request_id,
      deciderTag: 'pal#0001',
      deciderId: '12345',
    });
    expect(out.result).toBe('approved');
    expect(out.sessionId).toMatch(/^sess_/);
    const session = await Auth.getSession(out.sessionId);
    expect(session.username).toBe('Steve');
    const updated = await Auth.getAuthRequest(req.request_id);
    expect(updated.status).toBe('approved');
    expect(updated.session_id).toBe(out.sessionId);
    expect(updated.decided_by).toBe('pal#0001');
  });

  it('approveAuthRequest find-or-creates the user and links the session to it', async () => {
    const req = await Auth.createAuthRequest({ username: 'Steve', ttlMs: 60_000 });
    const out = await Auth.approveAuthRequest({ requestId: req.request_id, deciderTag: 'a' });
    expect(out.user.name).toBe('Steve');
    const session = await Auth.getSession(out.sessionId);
    expect(String(session.user_id)).toBe(String(out.user._id));
    expect((await Users.listUsers()).length).toBe(1);
  });

  it('same name in a different casing reuses the user and canonicalizes the session username', async () => {
    const first = await Auth.createAuthRequest({ username: 'Steve', ttlMs: 60_000 });
    const a = await Auth.approveAuthRequest({ requestId: first.request_id, deciderTag: 'a' });
    const second = await Auth.createAuthRequest({ username: 'sTEVE', ttlMs: 60_000 });
    const b = await Auth.approveAuthRequest({ requestId: second.request_id, deciderTag: 'b' });
    expect(String(b.user._id)).toBe(String(a.user._id));
    expect((await Users.listUsers()).length).toBe(1);
    // Second device's session carries the first-seen display casing.
    const session = await Auth.getSession(b.sessionId);
    expect(session.username).toBe('Steve');
  });

  it('denyAuthRequest marks denied without creating a session', async () => {
    const req = await Auth.createAuthRequest({ username: 'Bob', ttlMs: 60_000 });
    const out = await Auth.denyAuthRequest({
      requestId: req.request_id,
      deciderTag: 'pal#0001',
    });
    expect(out.result).toBe('denied');
    const updated = await Auth.getAuthRequest(req.request_id);
    expect(updated.status).toBe('denied');
    expect(updated.session_id).toBeFalsy();
  });

  it('rejects approving an already-decided request', async () => {
    const req = await Auth.createAuthRequest({ username: 'Bob', ttlMs: 60_000 });
    await Auth.approveAuthRequest({ requestId: req.request_id, deciderTag: 'a' });
    const second = await Auth.approveAuthRequest({ requestId: req.request_id, deciderTag: 'b' });
    expect(second.result).toBe('already_decided');
  });

  it('returns "not_found" for an unknown request id', async () => {
    const out = await Auth.approveAuthRequest({ requestId: 'req_nope', deciderTag: 'x' });
    expect(out.result).toBe('not_found');
  });

  it('getSession returns null for unknown ids', async () => {
    expect(await Auth.getSession('nope')).toBeNull();
    expect(await Auth.getSession('')).toBeNull();
    expect(await Auth.getSession(undefined)).toBeNull();
  });

  it('touchSession updates last_seen', async () => {
    const req = await Auth.createAuthRequest({ username: 'Bob', ttlMs: 60_000 });
    const { sessionId } = await Auth.approveAuthRequest({
      requestId: req.request_id,
      deciderTag: 'a',
    });
    const before = (await Auth.getSession(sessionId)).last_seen;
    await new Promise((r) => setTimeout(r, 5));
    await Auth.touchSession(sessionId);
    const after = (await Auth.getSession(sessionId)).last_seen;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
