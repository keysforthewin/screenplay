// Scene Bible auto-fill: the module that turns a beat into the 8 scene-bible
// fields via one forced-tool LLM pass, the REST endpoint that drives it, and the
// gateway fallback that persists scene_bible.* writes when Hocuspocus is off.
//
// The Anthropic client is mocked to return a canned fill_scene_bible tool call,
// so these tests exercise the wiring (context build → tool parse → normalize →
// gateway write → Mongo) without a real model.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

// Mutable holder the mocked Anthropic client reads from (hoisted so the vi.mock
// factory can close over it).
const h = vi.hoisted(() => ({ toolInput: null, createCalls: [], emptyContent: false }));

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
            : [{ type: 'tool_use', name: 'fill_scene_bible', input: h.toolInput }],
        };
      },
    },
  }),
}));
vi.mock('../src/web/auth.js', () => ({
  requireSession: () => (_req, _res, next) => next(),
}));
vi.mock('../src/web/announceHelpers.js', () => ({
  announceBeatMedia: vi.fn(),
  announceCharacterMedia: vi.fn(),
  announceNoteMedia: vi.fn(),
  announceStoryboardMedia: vi.fn(),
  announceLibraryMedia: vi.fn(),
  announceBatchSummary: vi.fn(),
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const { addDirectorNote } = await import('../src/mongo/directorNotes.js');
const Gateway = await import('../src/web/gateway.js');
const { withBeatLock, _clearBeatLocksForTests } = await import('../src/web/beatLocks.js');
const { SCENE_BIBLE_FIELDS } = await import('../src/mongo/sceneBible.js');
const { autofillSceneBible, buildSceneBibleContext } = await import(
  '../src/web/sceneBibleAutofill.js'
);
const { buildApiRouter } = await import('../src/web/entityRoutes.js');

const FULL = {
  location: 'Corner diner, booth by the window',
  time_of_day: 'Dusk, rain starting',
  lighting_key: 'Cold blue fill + warm sodium practicals',
  palette: 'Teal, amber, wet asphalt grey',
  mood: 'Quiet, waiting, unspoken tension',
  blocking: 'Sarah at booth screen-left; door screen-right behind her',
  continuity_anchors: 'Rain on windows throughout; red coat; chipped mug',
  camera_language: 'Mostly locked-off; occasional slow push',
};

function reloadBeat(beatId) {
  return Plots.getBeat(String(beatId));
}

beforeEach(() => {
  fakeDb.reset();
  _clearBeatLocksForTests();
  h.toolInput = { ...FULL };
  h.createCalls = [];
  h.emptyContent = false;
});

// Hold the beat lock open for the duration of `fn`, then release it.
async function whileBeatLocked(beatId, fn) {
  let release;
  const held = withBeatLock(beatId, () => new Promise((r) => { release = r; }));
  try {
    return await fn();
  } finally {
    release();
    await held;
  }
}

describe('autofillSceneBible (module)', () => {
  it('fills all 8 fields and persists them to beat.scene_bible', async () => {
    const beat = await Plots.createBeat({ name: 'Diner', body: 'Sarah waits in the rain.' });

    const result = await autofillSceneBible({ beatId: beat._id.toString() });

    for (const f of SCENE_BIBLE_FIELDS) {
      expect(result.scene_bible[f]).toBe(FULL[f]);
    }
    const fresh = await reloadBeat(beat._id);
    for (const f of SCENE_BIBLE_FIELDS) {
      expect(fresh.scene_bible[f]).toBe(FULL[f]);
    }
    // Forced tool was requested.
    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0].tool_choice).toEqual({ type: 'tool', name: 'fill_scene_bible' });
  });

  it('normalizes partial/garbage model output into all 8 keys', async () => {
    const beat = await Plots.createBeat({ name: 'Sparse' });
    h.toolInput = { location: 'Rooftop', mood: 'Tense', bogus_field: 'ignored', palette: 42 };

    const result = await autofillSceneBible({ beatId: beat._id.toString() });

    expect(Object.keys(result.scene_bible).sort()).toEqual([...SCENE_BIBLE_FIELDS].sort());
    expect(result.scene_bible.location).toBe('Rooftop');
    expect(result.scene_bible.mood).toBe('Tense');
    expect(result.scene_bible.palette).toBe(''); // non-string coerced to ''
    expect(result.scene_bible.camera_language).toBe(''); // missing -> ''
    expect(result.scene_bible).not.toHaveProperty('bogus_field');
  });

  it('throws when the model does not call the tool', async () => {
    const beat = await Plots.createBeat({ name: 'NoTool' });
    h.emptyContent = true;
    await expect(autofillSceneBible({ beatId: beat._id.toString() })).rejects.toThrow();
  });

  it('throws when the beat does not exist', async () => {
    await expect(autofillSceneBible({ beatId: new ObjectId().toString() })).rejects.toThrow(
      /not found/i,
    );
  });

  it('fails fast (BeatBusyError) when the beat is already locked', async () => {
    const beat = await Plots.createBeat({ name: 'Busy' });
    await whileBeatLocked(beat._id.toString(), async () => {
      await expect(autofillSceneBible({ beatId: beat._id.toString() })).rejects.toMatchObject({
        code: 'BEAT_BUSY',
      });
    });
    // No write happened while busy.
    expect(h.createCalls).toHaveLength(0);
  });
});

describe('buildSceneBibleContext', () => {
  it('includes the logline and the beat body', async () => {
    await Plots.updatePlot({ title: 'Neon City', synopsis: 'A courier outruns her past.' });
    const beat = await Plots.createBeat({ name: 'Chase', body: 'She sprints down the wet alley.' });

    const ctx = await buildSceneBibleContext(await reloadBeat(beat._id));

    expect(ctx).toContain('Logline: A courier outruns her past.');
    expect(ctx).toContain('She sprints down the wet alley.');
    expect(ctx).toContain('Chase');
  });

  it('includes character bios and director notes', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      fields: { background_story: 'Former courier.' },
    });
    await addDirectorNote({ text: 'Keep it rain-soaked throughout.' });
    const beat = await Plots.createBeat({ name: 'Meet', characters: ['Alice'] });

    const ctx = await buildSceneBibleContext(await reloadBeat(beat._id));

    expect(ctx).toContain('## Alice');
    expect(ctx).toContain('background_story: Former courier.');
    expect(ctx).toContain('Keep it rain-soaked throughout.');
  });
});

describe('gateway fallback for scene_bible.* (no Hocuspocus)', () => {
  it('setEntityFieldMarkdown writes beat.scene_bible.<field> through a null bible', async () => {
    const beat = await Plots.createBeat({ name: 'Bible' });
    expect(beat.scene_bible).toBeNull();

    await Gateway.setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: beat._id.toString(),
      field: 'scene_bible.mood',
      markdown: 'Tense, electric',
    });

    const fresh = await reloadBeat(beat._id);
    expect(fresh.scene_bible.mood).toBe('Tense, electric');
    // Other fields normalized to empty strings, not dropped.
    expect(fresh.scene_bible.location).toBe('');
  });

  it('preserves earlier scene_bible fields on a later field write', async () => {
    const beat = await Plots.createBeat({ name: 'Bible2' });
    await Gateway.setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: beat._id.toString(),
      field: 'scene_bible.location',
      markdown: 'Pier at night',
    });
    await Gateway.setEntityFieldMarkdown({
      entityType: 'beat',
      entityId: beat._id.toString(),
      field: 'scene_bible.palette',
      markdown: 'Sodium orange, black water',
    });

    const fresh = await reloadBeat(beat._id);
    expect(fresh.scene_bible.location).toBe('Pier at night');
    expect(fresh.scene_bible.palette).toBe('Sodium orange, black water');
  });
});

describe('POST /api/beat/:beatId/scene-bible/autofill (endpoint)', () => {
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

  it('returns the generated scene bible and persists it', async () => {
    const beat = await Plots.createBeat({ name: 'Endpoint', body: 'A tense standoff.' });

    const res = await fetch(`${baseUrl}/api/beat/${beat._id.toString()}/scene-bible/autofill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.scene_bible.mood).toBe(FULL.mood);
    const fresh = await reloadBeat(beat._id);
    expect(fresh.scene_bible.location).toBe(FULL.location);
  });

  it('404s for an unknown beat', async () => {
    const res = await fetch(
      `${baseUrl}/api/beat/${new ObjectId().toString()}/scene-bible/autofill`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(res.status).toBe(404);
  });

  it('409s when the beat is busy', async () => {
    const beat = await Plots.createBeat({ name: 'Busy endpoint' });
    const status = await whileBeatLocked(beat._id.toString(), async () => {
      const res = await fetch(
        `${baseUrl}/api/beat/${beat._id.toString()}/scene-bible/autofill`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      return res.status;
    });
    expect(status).toBe(409);
  });
});
