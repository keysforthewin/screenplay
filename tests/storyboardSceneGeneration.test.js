// tests/storyboardSceneGeneration.test.js
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
import {
  CAMERA_MOTION_RULES,
  STILL_FRAMING_RULES,
  VIDEO_PROMPT_RULES,
  CAMERA_COHERENCE_RULES,
  PERFORMANCE_RULES,
  CONTINUITY_STATE_RULES,
} from '../src/web/storyboardConstraints.js';
import { normalizeSceneBible as normalizeBibleForTest } from '../src/mongo/sceneBible.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { anthropicState } = vi.hoisted(() => ({ anthropicState: { resp: null } }));
vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => ({
    messages: {
      create: async () => anthropicState.resp,
      stream: () => ({ finalMessage: async () => anthropicState.resp }),
    },
  }),
}));

const { createProject } = await import('../src/mongo/projects.js');
const gen = await import('../src/web/storyboardGenerate.js');
const { SCENE_PLAN_SYSTEM_PROMPT, SHOT_EXPAND_SYSTEM_PROMPT } = gen;

describe('scene-plan building blocks (Pass 1)', () => {
  it('exports SCENE_PLAN_SYSTEM_PROMPT as a non-empty string', () => {
    expect(typeof SCENE_PLAN_SYSTEM_PROMPT).toBe('string');
    expect(SCENE_PLAN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('the scene-plan prompt embeds the shared constraint blocks (no duplication)', () => {
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(CAMERA_MOTION_RULES);
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(CAMERA_COHERENCE_RULES);
    expect(SCENE_PLAN_SYSTEM_PROMPT).toContain(PERFORMANCE_RULES);
  });

  it('the scene-plan prompt no longer teaches reveal inversion', () => {
    expect(SCENE_PLAN_SYSTEM_PROMPT).not.toContain('reverse_in_post');
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
  it('exports SHOT_EXPAND_SYSTEM_PROMPT embedding performance + continuity + still-framing + video-prompt rules', () => {
    expect(typeof SHOT_EXPAND_SYSTEM_PROMPT).toBe('string');
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(PERFORMANCE_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(CONTINUITY_STATE_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(STILL_FRAMING_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(VIDEO_PROMPT_RULES);
    expect(SHOT_EXPAND_SYSTEM_PROMPT).toContain(CAMERA_COHERENCE_RULES);
  });

  it('the shot-expand prompt no longer teaches reveal inversion', () => {
    expect(SHOT_EXPAND_SYSTEM_PROMPT).not.toContain('reverse_in_post');
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
  it('returns one {video_prompt} per skeleton shot via override; no still/end prompts', async () => {
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({
        video_prompt: `move ${i}`,
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
    expect(shots[0]).toMatchObject({ video_prompt: 'move 0' });
    expect(shots[0]).not.toHaveProperty('start_frame_prompt');
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
              { shot_index: 2, video_prompt: 'real move 2' },
            ],
          },
        },
      ],
    };
    const outline = [
      { description: 'first beat', shot_type: 'medium', duration_seconds: 4 },
      { description: 'second beat', shot_type: 'close_up', duration_seconds: 3 },
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
    expect(shots[0].video_prompt).toContain('first beat');
    // shot 2 kept the model's real prompt
    expect(shots[1].video_prompt).toBe('real move 2');
    anthropicState.resp = null;
  });
});

describe('planFramesV2 (two-pass orchestration)', () => {
  it('runs scene plan then expand, returns cleaned frames + the bible, one prompt per shot', async () => {
    gen._setScenePlannerForTests(() => ({
      sceneBible: normalizeBibleForTest({ location: 'Diner', mood: 'tense' }),
      outline: [
        { description: 'wide of diner', shot_type: 'establishing', duration_seconds: 6 },
        { description: 'Sarah looks up', shot_type: 'close_up', duration_seconds: 3, characters_in_scene: ['Sarah'] },
      ],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ video_prompt: `v${i}` })),
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
    expect(frames[0]).toMatchObject({ video_prompt: 'v0', shot_type: 'establishing', dialog_ids: [] });
    expect(frames[0]).not.toHaveProperty('start_frame_prompt');
    expect(frames[0]).not.toHaveProperty('end_frame_prompt');
    expect(frames[0].duration_seconds).toBe(6);

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
  });

  it('maps planner dialog_lines to dialog_ids and times dialogue shots off the covered lines', async () => {
    const { ObjectId } = await import('mongodb');
    const d1 = { _id: new ObjectId(), order: 1, character: 'Sarah', body: 'You said you would be here by six, and I waited.', direction: '' };
    const d2 = { _id: new ObjectId(), order: 2, character: 'Tom', body: 'I know.', direction: '', audio_file_id: new ObjectId(), audio_duration_seconds: 1.4 };
    gen._setScenePlannerForTests(() => ({
      sceneBible: normalizeBibleForTest({ location: 'Diner' }),
      outline: [
        { description: 'wide', shot_type: 'establishing', duration_seconds: 6 },
        { description: 'Sarah speaks', shot_type: 'close_up', duration_seconds: 2, characters_in_scene: ['Sarah'], dialog_lines: [1] },
        { description: 'Tom answers', shot_type: 'close_up', duration_seconds: 5, characters_in_scene: ['Tom'], dialog_lines: [2, 99] },
      ],
    }));
    gen._setShotExpanderForTests(({ outline }) => outline.map((f, i) => ({ video_prompt: `v${i}` })));

    const { frames } = await gen._planFramesV2ForTest({
      beat: { name: 'Diner', order: 1, body: 'x', desc: '', characters: ['Sarah', 'Tom'] },
      characters: [{ name: 'Sarah' }, { name: 'Tom' }],
      targetCount: 3,
      direction: '',
      directorNotes: [],
      dialogs: [d1, d2],
    });

    expect(frames[0].dialog_ids).toEqual([]);
    expect(frames[0].duration_seconds).toBe(6); // silent: planner's pick
    expect(frames[1].dialog_ids.map(String)).toEqual([String(d1._id)]);
    // 10 words / 2.5 w/s + pauses + breath ≈ 5.x → ceil 5 (cap 5 for close_up)
    expect(frames[1].duration_seconds).toBe(5);
    // out-of-range 99 dropped; recorded line: ceil(1.4 + 0.8) = 3
    expect(frames[2].dialog_ids.map(String)).toEqual([String(d2._id)]);
    expect(frames[2].duration_seconds).toBe(3);

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
  it('persists the bible on the beat and seeds exactly one blank start frame per row', async () => {
    const { createBeat, getBeat } = await import('../src/mongo/plots.js');
    const projectId = (await createProject('Test Project'))._id.toString();
    await createBeat({ projectId, name: 'DinerE2', desc: 'A diner scene', characters: [] });
    const beat = await getBeat(projectId, 'DinerE2');

    gen._setScenePlannerForTests(() => ({
      sceneBible: normalizeBibleForTest({ location: 'Diner' }),
      outline: [{ description: 'wide', shot_type: 'establishing', duration_seconds: 6 }],
    }));
    gen._setShotExpanderForTests(({ outline }) =>
      outline.map((f, i) => ({ video_prompt: `vid${i}` })),
    );
    gen._setImageDispatcherForTests(() => { throw new Error('should not render during generation'); });

    const jobId = await gen.startStoryboardGenerationJob({ projectId, beatId: beat._id.toString(), targetCount: 1 });
    for (let i = 0; i < 100; i++) {
      const job = gen.getStoryboardGenerationJob(jobId);
      if (job && ['done', 'partial', 'error'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = gen.getStoryboardGenerationJob(jobId);
    expect(job.status).not.toBe('error');

    const updatedBeat = await getBeat(projectId, 'DinerE2');
    expect(updatedBeat.scene_bible.location).toBe('Diner');

    const { listStoryboards } = await import('../src/mongo/storyboards.js');
    const sbs = await listStoryboards({ beatId: beat._id });
    expect(sbs).toHaveLength(1);
    expect(sbs[0].frames).toHaveLength(1); // one start frame, no end frame
    expect(sbs[0].frames[0].prompt).toBe(''); // renders from text_prompt
    expect(sbs[0].text_prompt).toBe('vid0');

    gen._setScenePlannerForTests(null);
    gen._setShotExpanderForTests(null);
    gen._setImageDispatcherForTests(null);
  });
});

describe('tool schemas', () => {
  const src = readFileSync(new URL('../src/web/storyboardGenerate.js', import.meta.url), 'utf8');

  it('transition_in names the cut vocabulary', () => {
    expect(src).toContain('J-cut');
    expect(src).toContain('L-cut');
    expect(src).toContain('smash cut');
  });

  it('the video_prompt schema description demands performance', () => {
    expect(src).toContain('listener behavior');
  });

  it('the video_prompt schema description demands continuity state in the opening composition', () => {
    expect(src).toContain('CONTINUITY STATE');
  });

  it('the expand tool emits exactly one prompt per shot', () => {
    expect(src).toContain("required: ['shot_index', 'video_prompt']");
    expect(src).not.toMatch(/start_frame_prompt:\s*\{/);
  });

  it('plan_scene carries dialog_lines and the coverage rules', () => {
    expect(src).toContain('dialog_lines');
    // The API rejects `minimum` on integer items in tool schemas (prod 400).
    const dl = gen.SCENE_PLAN_TOOL.input_schema.properties.frames.items.properties.dialog_lines;
    expect(dl.items).toEqual({ type: 'integer' });
    expect(gen.SCENE_PLAN_SYSTEM_PROMPT).toContain('Dialogue coverage');
    expect(gen.SCENE_PLAN_SYSTEM_PROMPT).toContain('EXACTLY ONE shot');
  });

  it('the feature is gone from the generator source', () => {
    expect(src).not.toContain('reverse_in_post');
    expect(src).not.toContain('reverseInPost');
  });
});
