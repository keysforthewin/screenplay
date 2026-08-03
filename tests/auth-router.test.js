// /auth router: is_admin flag on /validate and /status, canonical-casing
// username on the approved status response. Runs the real router over an
// ephemeral HTTP server with a stubbed Discord channel.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import express from 'express';
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

const { buildAuthRouter, bindDiscordClient } = await import('../src/web/auth.js');
const Auth = await import('../src/mongo/auth.js');

const sentMessages = [];
bindDiscordClient({
  channels: {
    fetch: async () => ({
      id: 'chan1',
      send: async (payload) => {
        sentMessages.push(payload);
        return { id: `msg${sentMessages.length}` };
      },
    }),
  },
});

const app = express();
app.use('/auth', buildAuthRouter());
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

afterAll(() => new Promise((resolve) => server.close(resolve)));

async function requestAndApprove(username) {
  const res = await fetch(`${baseUrl}/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const { request_id } = await res.json();
  await Auth.approveAuthRequest({ requestId: request_id, deciderTag: 'pal#0001' });
  return request_id;
}

describe('/auth router permissions surface', () => {
  beforeEach(() => {
    fakeDb.reset();
    sentMessages.length = 0;
    process.env.ADMIN_USERNAME = 'Boss';
  });
  afterEach(() => {
    process.env.ADMIN_USERNAME = '';
  });

  it('status returns is_admin true for the admin name (any casing)', async () => {
    const requestId = await requestAndApprove('bOSS');
    const status = await (
      await fetch(`${baseUrl}/auth/status?request_id=${requestId}`)
    ).json();
    expect(status.status).toBe('approved');
    expect(status.is_admin).toBe(true);
  });

  it('status returns is_admin false for members and the session-canonical username', async () => {
    await requestAndApprove('Steve');
    const requestId = await requestAndApprove('sTEVE');
    const status = await (
      await fetch(`${baseUrl}/auth/status?request_id=${requestId}`)
    ).json();
    expect(status.status).toBe('approved');
    expect(status.is_admin).toBe(false);
    expect(status.username).toBe('Steve');
  });

  it('validate reports is_admin per the live env var', async () => {
    const requestId = await requestAndApprove('Boss');
    const status = await (
      await fetch(`${baseUrl}/auth/status?request_id=${requestId}`)
    ).json();
    const validate = async () =>
      (
        await fetch(`${baseUrl}/auth/validate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: status.session_id }),
        })
      ).json();
    expect(await validate()).toMatchObject({ valid: true, username: 'Boss', is_admin: true });
    process.env.ADMIN_USERNAME = '';
    expect(await validate()).toMatchObject({ valid: true, username: 'Boss', is_admin: false });
  });
});
