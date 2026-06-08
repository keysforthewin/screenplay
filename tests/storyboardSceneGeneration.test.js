// tests/storyboardSceneGeneration.test.js
import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import {
  CAMERA_MOTION_RULES,
  REVEAL_HANDLING,
  SUBJECT_MOTION_RULES,
  STILL_FRAMING_RULES,
} from '../src/web/storyboardConstraints.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { anthropicState } = vi.hoisted(() => ({ anthropicState: { resp: null } }));
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => ({ messages: { create: async () => anthropicState.resp } }),
}));

const gen = await import('../src/web/storyboardGenerate.js');
const { SCENE_PLAN_SYSTEM_PROMPT, SHOT_EXPAND_SYSTEM_PROMPT } = gen;

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

describe('shot-expand building blocks (Pass 2)', () => {
  it('exports SHOT_EXPAND_SYSTEM_PROMPT embedding subject + still-framing rules', () => {
    expect(typeof SHOT_EXPAND_SYSTEM_PROMPT).toBe('string');
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(SUBJECT_MOTION_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(STILL_FRAMING_RULES);
  });
});

describe('expandShots (Pass 2)', () => {
  it('returns one {start_frame_prompt, video_prompt} per skeleton shot via override; no end frame', async () => {
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({
        start_frame_prompt: `start ${i}`,
        video_prompt: `move ${i}`,
        reverse_in_post: Boolean(f.reverse_in_post),
      })),
    );
    const outline = [
      { description: 'a', shot_type: 'medium', duration_seconds: 4 },
      { description: 'b', shot_type: 'close_up', duration_seconds: 3 },
    ];
    const shots = await gen._expandShotsForTest({
      beat: { name: 'X', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      sceneBible: { location: 'Diner' },
      outline,
      direction: '',
      directorNotes: [],
    });
    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({ start_frame_prompt: 'start 0', video_prompt: 'move 0' });
    expect(shots[0]).not.toHaveProperty('end_frame_prompt');
    gen._setShotExpanderForTests(null);
  });

  it('synthesizes a fallback for a shot the model omits, keeps real prompts for others', async () => {
    gen._setShotExpanderForTests(null); // use the real expandShots body
    anthropicState.resp = {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'tool_use',
          name: 'expand_shots',
          input: {
            shots: [
              // shot 1 omitted entirely; only shot 2 returned
              { shot_index: 2, start_frame_prompt: 'real start 2', video_prompt: 'real move 2' },
            ],
          },
        },
      ],
    };
    const outline = [
      { description: 'first beat', shot_type: 'medium', duration_seconds: 4, reverse_in_post: false },
      { description: 'second beat', shot_type: 'close_up', duration_seconds: 3, reverse_in_post: false },
    ];
    const shots = await gen._expandShotsForTest({
      beat: { name: 'X', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      sceneBible: { location: 'Diner' },
      outline,
      direction: '',
      directorNotes: [],
    });
    expect(shots).toHaveLength(2);
    // shot 1 fell back to a synthesized prompt mentioning its description
    expect(shots[0].start_frame_prompt).toContain('first beat');
    expect(shots[0].video_prompt).toContain('first beat');
    // shot 2 kept the model's real prompts
    expect(shots[1].start_frame_prompt).toBe('real start 2');
    expect(shots[1].video_prompt).toBe('real move 2');
    anthropicState.resp = null;
  });
});
