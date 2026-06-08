// tests/storyboardSceneGeneration.test.js
import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import { CAMERA_MOTION_RULES, REVEAL_HANDLING } from '../src/web/storyboardConstraints.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const gen = await import('../src/web/storyboardGenerate.js');
const { SCENE_PLAN_SYSTEM_PROMPT } = gen;

describe('scene-plan building blocks (Pass 1)', () => {
  it('exports SCENE_PLAN_SYSTEM_PROMPT as a non-empty string', () => {
    expect(typeof SCENE_PLAN_SYSTEM_PROMPT).toBe('string');
    expect(SCENE_PLAN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('the scene-plan prompt embeds the shared constraint blocks (no duplication)', () => {
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(CAMERA_MOTION_RULES);
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(REVEAL_HANDLING);
  });

  it('planScene (via override) returns { sceneBible, outline }', async () => {
    gen._setScenePlannerForTests(() => ({
      sceneBible: { location: 'Diner' },
      outline: [{ description: 'wide', shot_type: 'establishing', duration_seconds: 6 }],
    }));
    const out = await gen._planSceneForTest({
      beat: { name: 'X', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      targetCount: 1,
      direction: '',
      directorNotes: [],
    });
    expect(out.sceneBible.location).toBe('Diner');
    expect(out.outline).toHaveLength(1);
    gen._setScenePlannerForTests(null);
  });
});
