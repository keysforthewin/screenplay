// Tests for POST /api/storyboards/preview-prompt — the read-only endpoint
// that returns the exact Pass 1 (scene-plan) system + user messages that
// would be sent to the planner, plus the Pass 2 (shot-expand) system prompt.
// Deterministic; no LLM call.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

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

vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async () => ({})),
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Dialogs = await import('../src/mongo/dialogs.js');
const { buildApiRouter } = await import('../src/web/entityRoutes.js');
const { SCENE_PLAN_SYSTEM_PROMPT, SHOT_EXPAND_SYSTEM_PROMPT } = await import(
  '../src/web/storyboardGenerate.js'
);

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

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

describe('POST /api/storyboards/preview-prompt', () => {
  it('returns the Stage A system + user messages for a beat', async () => {
    await Characters.createCharacter({ projectId,
      name: 'Alice',
      fields: { role: 'protagonist' },
    });
    await Characters.createCharacter({ projectId, name: 'Bob' });
    const beat = await Plots.createBeat({ projectId,
      name: 'Diner reunion',
      desc: 'Alice meets Bob at the diner.',
      body: 'Alice arrives at the diner. She finds Bob in the back booth.',
      characters: ['Alice', 'Bob'],
    });

    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 9,
    });
    expect(status).toBe(200);
    expect(typeof json.system).toBe('string');
    expect(json.system).toMatch(/Hollywood storyboard artist/);
    expect(typeof json.user).toBe('string');
    expect(json.user).toMatch(/Diner reunion/);
    expect(json.user).toMatch(/Alice meets Bob at the diner/);
    expect(json.user).toMatch(/Alice arrives at the diner/);
    expect(json.user).toMatch(/- Alice — protagonist/);
    expect(json.user).toMatch(/- Bob/);
    expect(json.user).toMatch(/EXACTLY 9 frames/);
    expect(json.user).toMatch(/produce 9 cinematic shots/);
    // Without `direction` the user message must not advertise an empty block.
    expect(json.user).not.toMatch(/Director's commentary:/);
    // Pass 2's system prompt is surfaced alongside the Pass 1 prompts.
    expect(typeof json.expand_system).toBe('string');
    expect(json.expand_system).toMatch(/expand_shots/);
  });

  it("includes the director's commentary when provided", async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 5,
      direction: 'lean handheld and dirty over-the-shoulders',
    });
    expect(status).toBe(200);
    expect(json.user).toMatch(/Director's commentary:/);
    expect(json.user).toMatch(/lean handheld and dirty over-the-shoulders/);
  });

  it('defaults to DEFAULT_TARGET_COUNT (11) when count is omitted', async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
    });
    expect(status).toBe(200);
    expect(json.user).toMatch(/EXACTLY 11 frames/);
  });

  it('returns 400 when beat_id is missing', async () => {
    const { status } = await postJson('/api/storyboards/preview-prompt', {});
    expect(status).toBe(400);
  });

  it("embeds every director's note in the user message when notes exist", async () => {
    const DirectorNotes = await import('../src/mongo/directorNotes.js');
    await DirectorNotes.addDirectorNote({ projectId,
      text: 'Visual rule: keep the palette desaturated except for the color red.',
    });
    await DirectorNotes.addDirectorNote({ projectId,
      text: 'Tone: dry comedy in the foreground, dread in the background.',
    });
    const beat = await Plots.createBeat({ projectId,
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: [],
    });

    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 5,
    });
    expect(status).toBe(200);
    expect(json.user).toMatch(/Director's notes \(project-wide guidance/);
    expect(json.user).toMatch(/desaturated except for the color red/);
    expect(json.user).toMatch(/dry comedy in the foreground, dread in the background/);
  });

  it('omits the director-notes section when no notes exist', async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'B',
      desc: 'd',
      body: 'b',
      characters: [],
    });
    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 5,
    });
    expect(status).toBe(200);
    expect(json.user).not.toMatch(/Director's notes/);
  });

  it('returns 404 when the beat does not exist', async () => {
    const { status } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: '0000aaaa0000aaaa0000aaaa',
    });
    expect(status).toBe(404);
  });
});

describe('directorial voice in the preview', () => {
  it('leads the user block with the project voice when one is set', async () => {
    await Plots.updatePlot(projectId, {
      directorial_voice: 'Observational naturalist: invisible camera, available light, late cuts.',
    });
    const beat = await Plots.createBeat({ projectId, name: 'V', desc: 'd', body: 'b', characters: [] });

    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 5,
    });

    expect(status).toBe(200);
    expect(json.user).toContain('# Directorial voice (project-wide');
    expect(json.user).toContain('Observational naturalist');
    // It leads: the voice biases everything under it, so it must precede the beat.
    expect(json.user.indexOf('# Directorial voice')).toBeLessThan(json.user.indexOf('# Beat #'));
    await Plots.updatePlot(projectId, { directorial_voice: '' });
  });

  it('omits the voice section entirely when the project has none', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'NV', desc: 'd', body: 'b', characters: [] });
    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
      count: 5,
    });
    expect(status).toBe(200);
    expect(json.user).not.toContain('Directorial voice');
  });
});

describe('the directing spine reaches both passes', () => {
  it('Pass 1 asks for the read, the intention, and the turn', () => {
    // Asserted against the shipped system prompt so the spine cannot be
    // silently dropped from the planner.
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain('THE TURN');
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain('SUBTEXT');
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain('INTENTION in one sentence');
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain('felt_intent');
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain('primary_spend');
  });

  it('Pass 2 is told the intent fields are the brief, not decoration', () => {
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain('felt_intent');
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain('primary_spend');
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain('emotionally inert');
  });

  it('both passes carry the anti-slop ban', () => {
    for (const p of [SCENE_PLAN_SYSTEM_PROMPT, SHOT_EXPAND_SYSTEM_PROMPT]) {
      expect(p).toContain('FORBIDDEN as prompt words');
      expect(p).toContain('NO NEGATION');
    }
  });
});

describe('dialogue in the preview', () => {
  it('includes the beat dialogue block with the no-words warning', async () => {
    const beat = await Plots.createBeat({ projectId,
      name: 'The Argument',
      desc: 'They fight.',
      body: 'INT. KITCHEN — NIGHT',
      characters: [],
    });
    const d1 = await Dialogs.createDialog({
      projectId, beatId: beat._id, order: 1, body: "You said you'd be here.", character: 'Sarah',
    });
    await Dialogs.updateDialog(projectId, d1._id, { direction: 'quiet, not accusing' });

    const { status, json } = await postJson('/api/storyboards/preview-prompt', {
      beat_id: beat._id.toString(),
    });
    expect(status).toBe(200);
    expect(json.user).toContain('Dialogue in this beat');
    expect(json.user).toContain('1. Sarah:');
    expect(json.user).toContain('direction: quiet, not accusing');
    expect(json.user).toContain('NEVER write these words');
  });
});
