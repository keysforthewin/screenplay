// Set description auto-generation: one forced-tool LLM pass over the beats
// that reference a set, whose paragraphs replace the set's description via the
// gateway (y-doc when Hocuspocus is up, Mongo fallback here). Mirrors
// scene-bible-autofill.test.js: the Anthropic client is mocked to return a
// canned write_set_description tool call.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';
import { config } from '../src/config.js';

const fakeDb = createFakeDb();

const h = vi.hoisted(() => ({ paragraphs: null, createCalls: [], emptyContent: false }));

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));
vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => ({
    messages: {
      create: async (args) => {
        h.createCalls.push(args);
        return {
          content: h.emptyContent
            ? []
            : [{ type: 'tool_use', name: 'write_set_description', input: { paragraphs: h.paragraphs } }],
        };
      },
    },
  }),
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/rag/queue.js', () => ({ enqueueReindex: () => {} }));
vi.mock('../src/rag/indexer.js', () => ({
  deleteEntity: async () => {},
  deleteProjectChunks: async () => {},
}));

const Projects = await import('../src/mongo/projects.js');
const Sets = await import('../src/mongo/sets.js');
const Plots = await import('../src/mongo/plots.js');
const { generateSetDescription } = await import('../src/web/setDescriptionGenerate.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await Projects.createProject('Test Project'))._id.toString();
  h.paragraphs = ['A narrow brick alley, three storeys deep.', 'Sodium lamps at each end, wet cobbles.'];
  h.createCalls = [];
  h.emptyContent = false;
});

function sentUserText() {
  return h.createCalls[0].messages[0].content[0].text;
}

describe('generateSetDescription (module)', () => {
  it('joins the paragraphs and replaces the set description via the gateway', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley', description: 'Old hand-written note.' });
    await Plots.createBeat({ projectId, name: 'One', body: 'INT. ALLEY - NIGHT', sets: ['Alley'] });

    const result = await generateSetDescription({ projectId, setId: set._id.toString() });

    expect(result.description).toBe(
      'A narrow brick alley, three storeys deep.\n\nSodium lamps at each end, wet cobbles.',
    );
    expect(result.beats_used).toBe(1);
    const fresh = await Sets.getSet(projectId, set._id.toString());
    expect(fresh.description).toBe(result.description);
    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0].tool_choice).toEqual({ type: 'tool', name: 'write_set_description' });
  });

  it('builds context from story, voice, existing description and ALL linked beats by default', async () => {
    await Plots.updatePlot(projectId, {
      title: 'Neon City',
      synopsis: 'A courier outruns her past.',
      directorial_voice: 'Handheld, close, no coverage.',
    });
    const set = await Sets.createSet({ projectId, name: 'Alley', description: 'Cramped and wet.' });
    await Plots.createBeat({ projectId, name: 'Chase', body: 'She sprints past the dumpsters.', sets: ['Alley'] });
    await Plots.createBeat({ projectId, name: 'Aftermath', body: 'Steam rises from a vent.', sets: ['alley'] });
    await Plots.createBeat({ projectId, name: 'Elsewhere', body: 'A rooftop far away.', sets: ['Rooftop'] });

    const result = await generateSetDescription({ projectId, setId: set._id.toString() });

    const text = sentUserText();
    expect(text).toContain('Logline: A courier outruns her past.');
    expect(text).toContain('Handheld, close, no coverage.');
    expect(text).toContain('Cramped and wet.');
    expect(text).toContain('She sprints past the dumpsters.');
    expect(text).toContain('Steam rises from a vent.');
    expect(text).not.toContain('A rooftop far away.');
    expect(result.beats_used).toBe(2);
  });

  it('restricts context to the selected beatIds', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    const b1 = await Plots.createBeat({ projectId, name: 'One', body: 'FIRST BEAT TEXT', sets: ['Alley'] });
    await Plots.createBeat({ projectId, name: 'Two', body: 'SECOND BEAT TEXT', sets: ['Alley'] });

    const result = await generateSetDescription({
      projectId,
      setId: set._id.toString(),
      beatIds: [b1._id.toString()],
    });

    expect(sentUserText()).toContain('FIRST BEAT TEXT');
    expect(sentUserText()).not.toContain('SECOND BEAT TEXT');
    expect(result.beats_used).toBe(1);
  });

  it('works for a set with zero linked beats (describes from name/description alone)', async () => {
    const set = await Sets.createSet({ projectId, name: 'Orphan Set', description: 'A lighthouse.' });
    const result = await generateSetDescription({ projectId, setId: set._id.toString() });
    expect(result.beats_used).toBe(0);
    expect(sentUserText()).toContain('A lighthouse.');
    const fresh = await Sets.getSet(projectId, set._id.toString());
    expect(fresh.description).toContain('narrow brick alley');
  });

  it('rejects with status 400 when explicit beatIds match no linked beat', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    await Plots.createBeat({ projectId, name: 'One', body: 'x', sets: ['Alley'] });
    await expect(
      generateSetDescription({ projectId, setId: set._id.toString(), beatIds: [new ObjectId().toString()] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.createCalls).toHaveLength(0);
  });

  it('rejects with status 404 for an unknown set', async () => {
    await expect(
      generateSetDescription({ projectId, setId: new ObjectId().toString() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('throws (and leaves the description untouched) when the model returns no tool call', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley', description: 'Keep me.' });
    h.emptyContent = true;
    await expect(generateSetDescription({ projectId, setId: set._id.toString() })).rejects.toThrow();
    expect((await Sets.getSet(projectId, set._id.toString())).description).toBe('Keep me.');
  });

  it('throws when the model returns only blank paragraphs', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley', description: 'Keep me.' });
    h.paragraphs = ['   ', ''];
    await expect(generateSetDescription({ projectId, setId: set._id.toString() })).rejects.toThrow();
    expect((await Sets.getSet(projectId, set._id.toString())).description).toBe('Keep me.');
  });

  it('threads the optional direction into the context', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    await generateSetDescription({ projectId, setId: set._id.toString(), direction: 'Emphasize the night look.' });
    expect(sentUserText()).toContain('Emphasize the night look.');
  });
});

describe('POST /api/set/:id/generate-description (endpoint)', () => {
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
    await new Promise((r) => server.close(() => r()));
  });

  const post = (path, body) =>
    fetch(`${baseUrl}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Project-Id': projectId },
      body: JSON.stringify(body || {}),
    });

  it('generates, persists and returns the description', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    await Plots.createBeat({ projectId, name: 'One', body: 'INT. ALLEY', sets: ['Alley'] });
    const r = await post(`/set/${set._id.toString()}/generate-description`, { beat_ids: [] });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.description).toContain('narrow brick alley');
    expect(json.beats_used).toBe(1);
    expect((await Sets.getSet(projectId, set._id.toString())).description).toBe(json.description);
  });

  it('resolves the set by name too', async () => {
    await Sets.createSet({ projectId, name: 'Alley' });
    expect((await post('/set/alley/generate-description')).status).toBe(200);
  });

  it('404s on an unknown set', async () => {
    expect((await post(`/set/${new ObjectId().toString()}/generate-description`)).status).toBe(404);
  });

  it('400s when ANTHROPIC_API_KEY is not configured', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    const saved = config.anthropic.apiKey;
    config.anthropic.apiKey = '';
    try {
      expect((await post(`/set/${set._id.toString()}/generate-description`)).status).toBe(400);
    } finally {
      config.anthropic.apiKey = saved;
    }
  });

  it('400s when beat_ids match nothing linked', async () => {
    const set = await Sets.createSet({ projectId, name: 'Alley' });
    await Plots.createBeat({ projectId, name: 'One', body: 'x', sets: ['Alley'] });
    const r = await post(`/set/${set._id.toString()}/generate-description`, {
      beat_ids: [new ObjectId().toString()],
    });
    expect(r.status).toBe(400);
  });
});
