// Unit tests for the two-phase beat plate planner. The real Anthropic calls are
// covered by the phase seams; the normalize/guard/verdict logic and the
// user-message builders are tested directly.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => ({}),
  connectMongo: async () => ({}),
}));
vi.mock('../src/mongo/images.js', () => ({
  readImageBuffer: vi.fn(async () => null),
  uploadGeneratedImage: vi.fn(async () => ({ _id: 'x' })),
}));

const Planner = await import('../src/web/beatSheetPlanner.js');

const beat = {
  order: 3,
  name: 'The Alley',
  desc: 'A chase ends.',
  body: 'INT. ALLEY - NIGHT\nRain falls. A dumpster overflows.',
  characters: ['Rae'],
};

beforeEach(() => {
  Planner._setScenePlatePlannerForTests(null);
  Planner._setScenePlateCritiqueForTests(null);
});

describe('buildScenePlatePlanUserText', () => {
  it('includes the beat context, director notes, and reference descriptions; no target count', () => {
    const text = Planner.buildScenePlatePlanUserText({
      beat,
      characters: [],
      direction: '',
      directorNotes: [{ text: 'Neo-noir mood' }],
      referenceInputs: [{ name: 'alley ref', description: 'wet brick alley at night' }],
    });
    expect(text).toContain('The Alley');
    expect(text).toContain('Rain falls.');
    expect(text).toContain('Neo-noir mood');
    expect(text).toContain('wet brick alley at night');
    expect(text.toLowerCase()).toContain('no target count');
  });

  it('omits the reference block when there are no reference inputs', () => {
    const text = Planner.buildScenePlatePlanUserText({ beat, characters: [], referenceInputs: [] });
    expect(text.toLowerCase()).not.toContain('reference images provided');
  });
});

describe('buildScenePlateCritiqueUserText', () => {
  it('includes the single plate and the beat context', () => {
    const text = Planner.buildScenePlateCritiqueUserText({
      beat,
      plate: { name: 'Alley — wide', prompt: 'wide empty alley', justification: 'establishes', quote: 'Rain falls.' },
    });
    expect(text).toContain('Alley — wide');
    expect(text).toContain('wide empty alley');
    expect(text).toContain('Rain falls.');
  });
});

describe('normalizeScenePlanImages', () => {
  it('drops entries missing name or prompt, trims, and carries justification/quote', () => {
    const out = Planner.normalizeScenePlanImages(
      [
        { name: '  Wide  ', prompt: '  a wide shot  ', justification: '  why  ', quote: '  Rain falls.  ' },
        { name: 'no prompt' },
        { prompt: 'no name' },
        { name: 'Insert', prompt: 'a detail' },
      ],
      { max: 10 },
    );
    expect(out).toEqual([
      { name: 'Wide', prompt: 'a wide shot', justification: 'why', quote: 'Rain falls.' },
      { name: 'Insert', prompt: 'a detail', justification: '', quote: '' },
    ]);
  });

  it('clamps to max', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, prompt: `p${i}` }));
    expect(Planner.normalizeScenePlanImages(many, { max: 5 })).toHaveLength(5);
  });

  it('returns [] for non-array / empty input', () => {
    expect(Planner.normalizeScenePlanImages(null, { max: 5 })).toEqual([]);
    expect(Planner.normalizeScenePlanImages([], { max: 5 })).toEqual([]);
  });
});

describe('planBeatSceneImages — phase 1', () => {
  it('returns normalized plates from the phase-1 seam (phase-2 keep)', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Establishing', prompt: 'wide empty alley, dusk', justification: 'sets place', quote: 'INT. ALLEY - NIGHT' },
      { name: '', prompt: 'dropped — no name', justification: '', quote: '' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images).toEqual([
      { name: 'Establishing', prompt: 'wide empty alley, dusk', justification: 'sets place', quote: 'INT. ALLEY - NIGHT' },
    ]);
  });

  it('returns { images: [] } when phase 1 yields nothing (phase 2 not invoked)', async () => {
    let phase2Calls = 0;
    Planner._setScenePlatePlannerForTests(async () => []);
    Planner._setScenePlateCritiqueForTests(async () => { phase2Calls += 1; return { verdict: 'keep' }; });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images).toEqual([]);
    expect(phase2Calls).toBe(0);
  });
});

describe('planBeatSceneImages — phase 2 verdicts', () => {
  function seedTwoPlates() {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'plate a', justification: 'ja', quote: 'qa' },
      { name: 'B', prompt: 'plate b', justification: 'jb', quote: 'qb' },
    ]));
  }

  it('keep leaves plates unchanged', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['A', 'B']);
    expect(images[0].prompt).toBe('plate a');
  });

  it('edit replaces the prompt and preserves the quote', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async (plate) =>
      plate.name === 'A' ? { verdict: 'edit', prompt: 'plate a, refined' } : { verdict: 'keep' });
    const { images } = await Planner.planBeatSceneImages({ beat });
    const a = images.find((i) => i.name === 'A');
    expect(a.prompt).toBe('plate a, refined');
    expect(a.quote).toBe('qa');
  });

  it('divide expands one plate into two, in place', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async (plate) =>
      plate.name === 'A'
        ? { verdict: 'divide', shots: [
            { name: 'A1', prompt: 'plate a1', justification: 'j1', quote: 'q1' },
            { name: 'A2', prompt: 'plate a2', justification: 'j2', quote: 'q2' },
          ] }
        : { verdict: 'keep' });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['A1', 'A2', 'B']);
  });

  it('cull drops the plate', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async (plate) =>
      plate.name === 'A' ? { verdict: 'cull' } : { verdict: 'keep' });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['B']);
  });

  it('caps the final list at MAX_SCENE_IMAGE_COUNT after divides', async () => {
    Planner._setScenePlatePlannerForTests(async () =>
      Array.from({ length: 15 }, (_, i) => ({ name: `n${i}`, prompt: `p${i}`, justification: '', quote: '' })));
    Planner._setScenePlateCritiqueForTests(async (plate) => ({
      verdict: 'divide',
      shots: [
        { name: `${plate.name}-x`, prompt: `${plate.prompt}-x`, justification: '', quote: '' },
        { name: `${plate.name}-y`, prompt: `${plate.prompt}-y`, justification: '', quote: '' },
      ],
    }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.length).toBe(Planner.MAX_SCENE_IMAGE_COUNT);
  });

  it('keeps the plate when the critique throws', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async () => { throw new Error('boom'); });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('never lets justification or quote leak into a prompt', async () => {
    seedTwoPlates();
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { images } = await Planner.planBeatSceneImages({ beat });
    for (const im of images) {
      expect(im.prompt).not.toContain(im.justification);
      expect(im.prompt).not.toContain(im.quote);
    }
  });
});

describe('planBeatSceneImages — onProgress', () => {
  it('emits planning and per-plate critiquing events', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'a', justification: '', quote: '' },
      { name: 'B', prompt: 'b', justification: '', quote: '' },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const phases = [];
    await Planner.planBeatSceneImages({ beat, onProgress: (e) => phases.push(e.phase + ':' + e.step) });
    expect(phases).toContain('planning:plan_start');
    expect(phases.filter((p) => p === 'critiquing:critique_done')).toHaveLength(2);
  });
});

describe('plate tools + system prompts', () => {
  it('exposes plan_scene_plates requiring name/prompt/justification/quote', () => {
    expect(Planner.SCENE_PLATE_PLAN_TOOL.name).toBe('plan_scene_plates');
    const item = Planner.SCENE_PLATE_PLAN_TOOL.input_schema.properties.plates.items;
    expect(item.required.sort()).toEqual(['justification', 'name', 'prompt', 'quote']);
    expect(Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT.toLowerCase()).toMatch(/background|environment|plate|location/);
  });

  it('plan prompt demands spatial geography, sub-location, and explicit occupancy', () => {
    const t = Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT.toLowerCase();
    expect(t).toContain('geography');
    expect(t).toContain('sub-location');
    expect(t).toContain('occupancy');
  });

  it('the plate prompt field tells the model to encode sub-location + occupancy', () => {
    const desc = Planner.SCENE_PLATE_PLAN_TOOL.input_schema.properties.plates.items.properties.prompt.description.toLowerCase();
    expect(desc).toContain('sub-location');
    expect(desc).toContain('occupancy');
  });

  it('exposes critique_scene_plate enumerating the four verdicts', () => {
    expect(Planner.SCENE_PLATE_CRITIQUE_TOOL.name).toBe('critique_scene_plate');
    expect(Planner.SCENE_PLATE_CRITIQUE_TOOL.input_schema.properties.verdict.enum.sort())
      .toEqual(['cull', 'divide', 'edit', 'keep']);
  });

  it('critique prompt checks spatial fidelity against the beat/quote', () => {
    const t = Planner.SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT.toLowerCase();
    expect(t).toContain('spatial');
  });

  it('plan prompt forbids moving/transient subjects and names the shooting-star case', () => {
    const t = Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT.toLowerCase();
    expect(t).toContain('clean plate');
    expect(t).toContain('shooting star');
    expect(t).toMatch(/moving|transient/);
  });

  it('the plate prompt field tells the model to drop moving subjects', () => {
    const desc = Planner.SCENE_PLATE_PLAN_TOOL.input_schema.properties.plates.items.properties.prompt.description.toLowerCase();
    expect(desc).toMatch(/moving|transient/);
  });

  it('critique prompt has a static-plate check that rewrites away moving subjects', () => {
    const t = Planner.SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT.toLowerCase();
    expect(t).toContain('static-plate');
    expect(t).toContain('shooting star');
  });
});

describe('buildScenePlatePlanUserText — revision request', () => {
  it('includes a revision section listing the previous plates when provided', () => {
    const text = Planner.buildScenePlatePlanUserText({
      beat,
      previousPlates: [
        { name: 'Old wide', prompt: 'wide empty alley at dusk' },
        { name: 'Old insert', prompt: 'wet brick texture' },
      ],
      direction: 'too many wides; want more interior detail',
    });
    expect(text.toLowerCase()).toContain('revision request');
    expect(text).toContain('Old wide');
    expect(text).toContain('wide empty alley at dusk');
    expect(text).toContain('Old insert');
  });

  it('omits the revision section when there are no previous plates', () => {
    const text = Planner.buildScenePlatePlanUserText({ beat });
    expect(text.toLowerCase()).not.toContain('revision request');
  });
});

describe('STATIC_PLATE_CONSTRAINTS', () => {
  it('is exported and embedded verbatim in the phase-1 system prompt', () => {
    expect(Planner.STATIC_PLATE_CONSTRAINTS).toContain('CLEAN PLATES');
    expect(Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT).toContain(Planner.STATIC_PLATE_CONSTRAINTS);
  });
});

describe('planBeatSceneImages — revision threading', () => {
  it('passes previousPlates to phase 1 but not to phase 2', async () => {
    let p1args = null;
    let p2ctx = null;
    Planner._setScenePlatePlannerForTests(async (args) => {
      p1args = args;
      return [{ name: 'A', prompt: 'a', justification: '', quote: '' }];
    });
    Planner._setScenePlateCritiqueForTests(async (_plate, ctx) => {
      p2ctx = ctx;
      return { verdict: 'keep' };
    });
    await Planner.planBeatSceneImages({
      beat,
      previousPlates: [{ name: 'Old', prompt: 'old plate' }],
    });
    expect(p1args.previousPlates).toEqual([{ name: 'Old', prompt: 'old plate' }]);
    expect(p2ctx.previousPlates).toBeUndefined();
  });
});
