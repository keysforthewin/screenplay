// Web chat: POST /api/chat starts an agent run against the browser's project
// and GET /api/chat/:runId/events streams progress over SSE. The run shares
// the Discord channel's conversation (channel_id = movieChannelId) and
// serializes through the same channel mutex as Discord turns.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (req, _res, next) => {
    req.session = { session_id: 'sid1', username: 'tester' };
    next();
  },
}));
vi.mock('../src/mongo/auth.js', () => ({
  getSession: async (sid) =>
    sid === 'sid1' ? { session_id: 'sid1', username: 'tester' } : null,
  touchSession: async () => {},
}));

const runAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../src/agent/loop.js', () => ({ runAgent: runAgentMock }));

vi.mock('../src/agent/promptEnhance.js', () => ({
  enhancePrompt: async () => ({ notes: null, summary: 'made a beat', usage: null }),
}));

const { config } = await import('../src/config.js');
const Projects = await import('../src/mongo/projects.js');
const ChatRuns = await import('../src/web/chatRuns.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

const IMAGE_ID = 'a'.repeat(24);

function defaultAgentResult({ projectId }) {
  return {
    text: 'hi there',
    attachmentPaths: [],
    attachmentLinks: [`http://localhost:3000/image/${IMAGE_ID}`],
    projectId,
    agentMessages: [
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ],
  };
}

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r()));
});
beforeEach(() => {
  fakeDb.reset();
  ChatRuns._resetChatRuns();
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async ({ onEvent, projectId }) => {
    onEvent?.({ type: 'tools', tools: ['create_beat'] });
    return defaultAgentResult({ projectId });
  });
});

const post = (path, body, headers = {}) =>
  fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function waitForRun(runId, status = 'done') {
  await vi.waitFor(
    () => {
      const run = ChatRuns.getChatRun(runId);
      if (!run || run.status !== status) throw new Error(`run not ${status} yet`);
    },
    { timeout: 2000 },
  );
  return ChatRuns.getChatRun(runId);
}

describe('POST /api/chat', () => {
  it('starts a run scoped to the browser project and records the shared transcript', async () => {
    const project = await Projects.createProject('Western');
    const pid = project._id.toString();

    const r = await post('/chat', { text: 'add a beat' }, { 'X-Project-Id': pid });
    expect(r.status).toBe(202);
    const { run_id } = await r.json();
    expect(run_id).toBeTruthy();

    const run = await waitForRun(run_id);
    expect(run.text).toBe('hi there');
    expect(run.interpreted).toBe('made a beat');
    expect(run.attachments).toEqual([
      { kind: 'image', url: `http://localhost:3000/image/${IMAGE_ID}` },
    ]);
    expect(run.progress.map((p) => p.label)).toContain('calling create_beat…');

    // runAgent got the browser's project and the web flag.
    const args = runAgentMock.mock.calls[0][0];
    expect(args.projectId).toBe(pid);
    expect(args.projectTitle).toBe('Western');
    expect(args.webRun).toBe(true);
    expect(args.channelId).toBe(config.discord.movieChannelId);

    // Shared transcript: user message + agent turn under the Discord channel id.
    const docs = await fakeDb.collection('messages').find({}).toArray();
    const user = docs.find((d) => d.role === 'user');
    expect(user.channel_id).toBe(config.discord.movieChannelId);
    expect(user.project_id).toBe(pid);
    expect(user.author.displayName).toBe('tester');
    expect(user.author.id).toBe('web:tester');
    expect(user.content).toBe('add a beat');
    const turns = docs.filter((d) => d.role === 'assistant');
    expect(turns).toHaveLength(1);
    expect(turns[0].project_id).toBe(pid);
  });

  it('400s on empty or oversized text', async () => {
    const r1 = await post('/chat', { text: '   ' });
    expect(r1.status).toBe(400);
    const r2 = await post('/chat', { text: 'x'.repeat(4001) });
    expect(r2.status).toBe(400);
  });

  it('records an apology to the shared transcript when the agent fails', async () => {
    runAgentMock.mockRejectedValueOnce(new Error('kaboom'));
    const project = await Projects.createProject('Western');
    const pid = project._id.toString();

    const r = await post('/chat', { text: 'do something' }, { 'X-Project-Id': pid });
    const { run_id } = await r.json();
    const run = await waitForRun(run_id, 'error');
    expect(run.error).toBe('kaboom');

    const docs = await fakeDb.collection('messages').find({}).toArray();
    const assistant = docs.find((d) => d.role === 'assistant');
    expect(assistant.content).toMatch(/internal error/);
    expect(assistant.channel_id).toBe(config.discord.movieChannelId);
  });

  it('serializes concurrent runs through the shared channel mutex', async () => {
    await Projects.createProject('Western');
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    runAgentMock.mockImplementation(async ({ projectId }) => {
      await gate;
      return defaultAgentResult({ projectId });
    });

    const r1 = await post('/chat', { text: 'first' });
    const { run_id: id1 } = await r1.json();
    await vi.waitFor(() => {
      if (ChatRuns.getChatRun(id1).status !== 'running') throw new Error('not running');
    });

    const r2 = await post('/chat', { text: 'second' });
    const { run_id: id2 } = await r2.json();
    // Second run must sit queued behind the first, not run concurrently.
    await new Promise((r) => setTimeout(r, 50));
    expect(ChatRuns.getChatRun(id2).status).toBe('queued');

    release();
    await waitForRun(id1);
    await waitForRun(id2);
  });
});

describe('GET /api/chat/:runId/events', () => {
  it('replays a terminal run as a snapshot and closes', async () => {
    const project = await Projects.createProject('Western');
    const pid = project._id.toString();
    const r = await post('/chat', { text: 'add a beat' }, { 'X-Project-Id': pid });
    const { run_id } = await r.json();
    await waitForRun(run_id);

    const res = await fetch(`${baseUrl}/api/chat/${run_id}/events?session_id=sid1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = await res.text();
    expect(body).toContain('event: snapshot');
    expect(body).toContain('"status":"done"');
    expect(body).toContain('"hi there"');
    expect(body).toContain('calling create_beat…');
  });

  it('streams progress and done events for a live run', async () => {
    await Projects.createProject('Western');
    let emitTools;
    let finish;
    const finished = new Promise((r) => {
      finish = r;
    });
    runAgentMock.mockImplementation(async ({ onEvent, projectId }) => {
      emitTools = () => onEvent({ type: 'tools', tools: ['update_plot'] });
      await finished;
      return defaultAgentResult({ projectId });
    });

    const r = await post('/chat', { text: 'go' });
    const { run_id } = await r.json();
    await vi.waitFor(() => {
      if (!emitTools) throw new Error('agent not started');
    });

    const res = await fetch(`${baseUrl}/api/chat/${run_id}/events?session_id=sid1`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readUntil = async (needle) => {
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('event: snapshot');
    emitTools();
    await readUntil('event: progress');
    expect(buf).toContain('calling update_plot…');
    finish();
    await readUntil('event: done');
    expect(buf).toContain('"status":"done"');
  });

  it('401s without a valid session and 404s on unknown runs', async () => {
    const r1 = await fetch(`${baseUrl}/api/chat/whatever/events`);
    expect(r1.status).toBe(401);
    const r2 = await fetch(`${baseUrl}/api/chat/whatever/events?session_id=bogus`);
    expect(r2.status).toBe(401);
    const r3 = await fetch(`${baseUrl}/api/chat/whatever/events?session_id=sid1`);
    expect(r3.status).toBe(404);
  });
});
