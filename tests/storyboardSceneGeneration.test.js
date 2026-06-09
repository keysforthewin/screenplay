// tests/storyboardSceneGeneration.test.js
import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import {
  CAMERA_MOTION_RULES,
  REVEAL_HANDLING,
  SUBJECT_MOTION_RULES,
  STILL_FRAMING_RULES,
  VIDEO_PROMPT_RULES,
} from '../src/web/storyboardConstraints.js';
import { normalizeSceneBible as normalizeBibleForTest } from '../src/mongo/sceneBible.js';

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
  it('exports SHOT_EXPAND_SYSTEM_PROMPT embedding subject + still-framing + video-prompt rules', () => {
    expect(typeof SHOT_EXPAND_SYSTEM_PROMPT).toBe('string');
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(SUBJECT_MOTION_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(STILL_FRAMING_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(VIDEO_PROMPT_RULES);
  });

  it('forbids proper names and requires a visual handle (actor likeness / described look)', () => {
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain('NEVER use');
    const t = SHOT_EXPAND_SYSTEM_PROMPT.toLowerCase();
    expect(t).toContain('proper name');
    expect(t).toContain('visual handle');
  });
});

describe('buildBeatContextBlock — character appearance plumbing', () => {
  const beat = { order: 1, name: 'Van', desc: 'd', body: 'b', characters: [] };

  it('surfaces hollywood_actor + background_story + memes + faction for each character', () => {
    const characters = [
      {
        name: 'Keys',
        hollywood_actor: 'Tom Green',
        fields: {
          background_story: 'A scrappy pilot in a patched flight jacket.',
          memes: 'formerly Nully',
          faction: 'Fruit Cup Fucks',
        },
      },
    ];
    const ctx = gen.buildBeatContextBlock({ beat, characters, direction: '', directorNotes: [] });
    expect(ctx).toContain('played by Tom Green');
    expect(ctx).toContain('A scrappy pilot in a patched flight jacket.');
    expect(ctx).toContain('formerly Nully');
    expect(ctx).toContain('Fruit Cup Fucks');
  });

  it('clips an over-long appearance field', () => {
    const characters = [
      { name: 'Tuna', fields: { background_story: 'X'.repeat(600) } },
    ];
    const ctx = gen.buildBeatContextBlock({ beat, characters, direction: '', directorNotes: [] });
    expect(ctx).toContain('…');
    expect(ctx).not.toContain('X'.repeat(600));
  });

  it('treats voice-only casting as non-visual: no "played by", relies on look', () => {
    const characters = [
      {
        name: 'Tuna',
        hollywood_actor: 'Jeremy Irons (voice only)',
        fields: { background_story: 'A fish in a black-and-yellow armored space suit.' },
      },
    ];
    const ctx = gen.buildBeatContextBlock({ beat, characters, direction: '', directorNotes: [] });
    expect(ctx).not.toContain('played by Jeremy Irons');
    expect(ctx).toContain('A fish in a black-and-yellow armored space suit.');
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

describe('planFramesV2 (two-pass orchestration)', () => {
  it('runs scene plan then expand, returns cleaned frames + the bible, no end frame', async () => {
    gen._setScenePlannerForTests(() => ({
      sceneBible: normalizeBibleForTest({ location: 'Diner', mood: 'tense' }),
      outline: [
        { description: 'wide of diner', shot_type: 'establishing', duration_seconds: 6 },
        { description: 'Sarah looks up', shot_type: 'close_up', duration_seconds: 3, characters_in_scene: ['Sarah'] },
      ],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ start_frame_prompt: `s${i}`, video_prompt: `v${i}`, reverse_in_post: false })),
    );

    const { frames, sceneBible } = await gen._planFramesV2ForTest({
      beat: { name: 'Diner', order: 1, body: 'x', desc: '', characters: ['Sarah'] },
      characters: [{ name: 'Sarah' }],
      targetCount: 2,
      direction: '',
      directorNotes: [],
    });

    expect(sceneBible.location).toBe('Diner');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ start_frame_prompt: 's0', video_prompt: 'v0', shot_type: 'establishing' });
    expect(frames[0]).not.toHaveProperty('end_frame_prompt');
    expect(frames[0].duration_seconds).toBe(6);

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
  });

  it('returns empty frames + bible when the scene planner returns no shots', async () => {
    gen._setScenePlannerForTests(() => ({ sceneBible: normalizeBibleForTest({ location: 'Void' }), outline: [] }));
    const { frames, sceneBible } = await gen._planFramesV2ForTest({
      beat: { name: 'Empty', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      targetCount: 3,
      direction: '',
      directorNotes: [],
    });
    expect(frames).toHaveLength(0);
    expect(sceneBible.location).toBe('Void');
    gen._setScenePlannerForTests(null);
  });
});

describe('expandShots revisionNotes', () => {
  it('includes revision notes in the user text when provided', () => {
    const text = gen.buildShotExpandUserText({
      beat: { name: 'X', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      sceneBible: { location: 'Diner' },
      outline: [{ description: 'a', shot_type: 'medium', duration_seconds: 4 }],
      direction: '',
      directorNotes: [],
      revisionNotes: 'Make the lighting colder; subject too close to edge.',
    });
    expect(text).toContain('Make the lighting colder');
  });

  it('omits the revision section when revisionNotes is empty', () => {
    const text = gen.buildShotExpandUserText({
      beat: { name: 'X', order: 1, body: '', desc: '', characters: [] },
      characters: [],
      sceneBible: { location: 'Diner' },
      outline: [{ description: 'a', shot_type: 'medium', duration_seconds: 4 }],
      direction: '',
      directorNotes: [],
    });
    expect(text).not.toContain('Revision notes');
  });
});

describe('end-to-end generation job (overrides)', () => {
  it('persists the bible on the beat and seeds exactly one start-frame prompt per row', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    await createBeat({ name: 'DinerE2', desc: 'A diner scene', characters: [] });
    const beat = await getBeat('DinerE2');

    gen._setScenePlannerForTests(() => ({
      sceneBible: normalizeBibleForTest({ location: 'Diner' }),
      outline: [{ description: 'wide', shot_type: 'establishing', duration_seconds: 6 }],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ start_frame_prompt: `start${i}`, video_prompt: `vid${i}`, reverse_in_post: false })),
    );
    gen._setImageDispatcherForTests(() => { throw new Error('should not render during generation'); });

    const jobId = await gen.startStoryboardGenerationJob({ beatId: beat._id.toString(), targetCount: 1 });
    for (let i = 0; i < 100; i++) {
      const job = gen.getStoryboardGenerationJob(jobId);
      if (job && ['done', 'partial', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = gen.getStoryboardGenerationJob(jobId);
    expect(job.status).not.toBe('error');

    const updatedBeat = await getBeat('DinerE2');
    expect(updatedBeat.scene_bible.location).toBe('Diner');

    const { listStoryboards } = await import('../src/mongo/storyboards.js');
    const sbs = await listStoryboards({ beatId: beat._id });
    expect(sbs).toHaveLength(1);
    expect(sbs[0].frames).toHaveLength(1); // only the start prompt seeded, not start+end
    expect(sbs[0].frames[0].prompt).toBe('start0');

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
    gen._setImageDispatcherForTests(null);
  });
});
