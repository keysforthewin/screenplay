// Route-level tests for POST /api/storyboard/:id/generate-summary. The route
// reads `text_prompt` server-side, calls analyzeText to produce a one-sentence
// summary, and writes the result to the storyboard's `summary` field via the
// gateway. In this fallback environment (no Hocuspocus running) the gateway
// writes directly to Mongo, so we assert the persisted value.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
const analyzeTextMock = vi.fn();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/llm/analyze.js', () => ({
  analyzeText: (...args) => analyzeTextMock(...args),
}));

const Storyboards = await import('../src/mongo/storyboards.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', buildApiRouter());
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fakeDb.reset();
  analyzeTextMock.mockReset();
});

const beatId = new ObjectId();

async function post(sbId) {
  const res = await fetch(`${baseUrl}/api/storyboard/${sbId}/generate-summary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

describe('POST /api/storyboard/:id/generate-summary', () => {
  it('returns 404 when the storyboard does not exist', async () => {
    const { status, json } = await post(new ObjectId().toString());
    expect(status).toBe(404);
    expect(json.error).toMatch(/not found/);
    expect(analyzeTextMock).not.toHaveBeenCalled();
  });

  it('returns 400 when text_prompt is empty', async () => {
    const sb = await Storyboards.createStoryboard({ beatId });
    const { status, json } = await post(sb._id.toString());
    expect(status).toBe(400);
    expect(json.error).toMatch(/empty/);
    expect(analyzeTextMock).not.toHaveBeenCalled();
  });

  it('summarizes text_prompt, writes summary via gateway, and returns the value', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId,
      textPrompt: 'Wide shot of the **diner** at dusk; Alice arrives.',
    });
    analyzeTextMock.mockResolvedValue('Alice arrives at the dusk diner.');

    const { status, json } = await post(sb._id.toString());
    expect(status).toBe(200);
    expect(json.summary).toBe('Alice arrives at the dusk diner.');
    expect(analyzeTextMock).toHaveBeenCalledTimes(1);

    // Markdown is stripped from the prompt before being passed to the LLM.
    const callArgs = analyzeTextMock.mock.calls[0][0];
    expect(callArgs.user).not.toMatch(/\*\*/);
    expect(callArgs.user).toMatch(/diner/);

    const fresh = await Storyboards.getStoryboard(sb._id);
    expect(fresh.summary).toBe('Alice arrives at the dusk diner.');
  });

  it('collapses whitespace in the model output', async () => {
    const sb = await Storyboards.createStoryboard({
      beatId,
      textPrompt: 'Something happens.',
    });
    analyzeTextMock.mockResolvedValue('  A\nmulti\nline   reply.  ');

    const { status, json } = await post(sb._id.toString());
    expect(status).toBe(200);
    expect(json.summary).toBe('A multi line reply.');
  });
});
