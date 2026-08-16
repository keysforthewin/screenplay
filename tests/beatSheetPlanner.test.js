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

  it('lists the available references and the plate\'s assigned indexes', () => {
    const text = Planner.buildScenePlateCritiqueUserText({
      beat,
      referenceInputs: [
        { id: 'a'.repeat(24), name: 'theater ref', description: 'art-deco movie theater at night' },
        { id: 'b'.repeat(24), name: 'sky ref', description: 'clear night sky' },
      ],
      plate: { name: 'Theater', prompt: 'the theater from the reference', justification: '', quote: '', reference_indexes: [1] },
    });
    expect(text).toContain('Reference image 1');
    expect(text).toContain('theater ref');
    expect(text).toContain('Reference image 2');
    expect(text.toLowerCase()).toContain('assigned reference');
    expect(text).toMatch(/assigned reference[^\n]*1/i);
  });
});

describe('buildScenePlatePlanContent — multimodal', () => {
  const refs = [
    { id: 'a'.repeat(24), name: 'theater ref', description: 'art-deco movie theater', buffer: Buffer.from('img-a'), contentType: 'image/png' },
    { id: 'b'.repeat(24), name: 'sky ref', description: 'night sky', buffer: Buffer.from('img-b'), contentType: 'image/jpeg' },
  ];

  it('returns the plan text followed by a labeled image block per reference', () => {
    const blocks = Planner.buildScenePlatePlanContent({ beat, referenceInputs: refs });
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('Rain falls.');
    const images = blocks.filter((b) => b.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from('img-a').toString('base64'),
    });
    expect(images[1].source.media_type).toBe('image/jpeg');
    const labels = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(labels).toContain('Reference image 1');
    expect(labels).toContain('Reference image 2');
    expect(labels).toContain('theater ref');
  });

  it('returns a single text block when there are no reference inputs', () => {
    const blocks = Planner.buildScenePlatePlanContent({ beat, referenceInputs: [] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
  });

  it('skips image blocks for references without bytes but keeps their numbering', () => {
    const blocks = Planner.buildScenePlatePlanContent({
      beat,
      referenceInputs: [
        { id: 'a'.repeat(24), name: 'no bytes', description: 'desc only' },
        refs[1],
      ],
    });
    const images = blocks.filter((b) => b.type === 'image');
    expect(images).toHaveLength(1);
    const labels = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    expect(labels).toContain('Reference image 2');
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
      { name: 'Wide', prompt: 'a wide shot', justification: 'why', quote: 'Rain falls.', reference_indexes: [], requires_reference: false },
      { name: 'Insert', prompt: 'a detail', justification: '', quote: '', reference_indexes: [], requires_reference: false },
    ]);
  });

  it('sanitizes reference_indexes to unique positive integers', () => {
    const out = Planner.normalizeScenePlanImages(
      [{ name: 'A', prompt: 'p', reference_indexes: [1, 1, 2.5, -1, 0, '3', 4] }],
      { max: 10 },
    );
    expect(out[0].reference_indexes).toEqual([1, 3, 4]);
  });

  it('carries requires_reference as a strict boolean (default false)', () => {
    const out = Planner.normalizeScenePlanImages(
      [
        { name: 'A', prompt: 'p', requires_reference: true },
        { name: 'B', prompt: 'p', requires_reference: 'yes' },
        { name: 'C', prompt: 'p' },
      ],
      { max: 10 },
    );
    expect(out.map((s) => s.requires_reference)).toEqual([true, true, false]);
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
      { name: 'Establishing', prompt: 'wide empty alley, dusk', justification: 'sets place', quote: 'INT. ALLEY - NIGHT', reference_image_ids: [], requires_reference: false },
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

describe('planBeatSceneImages — per-plate reference resolution', () => {
  const referenceInputs = [
    { id: 'a'.repeat(24), name: 'theater ref', description: 'movie theater' },
    { id: 'b'.repeat(24), name: 'sky ref', description: 'night sky' },
    { id: 'c'.repeat(24), name: 'street ref', description: 'street' },
  ];

  it('resolves reference_indexes to reference_image_ids, dropping out-of-range indexes', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Starfield', prompt: 'the Milky Way', justification: '', quote: '', reference_indexes: [] },
      { name: 'Theater', prompt: 'the theater from the reference', justification: '', quote: '', reference_indexes: [1, 3, 99] },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'keep' }));
    const { images } = await Planner.planBeatSceneImages({ beat, referenceInputs });
    expect(images.find((i) => i.name === 'Starfield').reference_image_ids).toEqual([]);
    expect(images.find((i) => i.name === 'Theater').reference_image_ids).toEqual([
      'a'.repeat(24),
      'c'.repeat(24),
    ]);
    for (const im of images) expect(im.reference_indexes).toBeUndefined();
  });

  it('a critique edit verdict can reassign a plate\'s references', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Theater', prompt: 'theater plate', justification: '', quote: '', reference_indexes: [1, 2] },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({ verdict: 'edit', prompt: 'theater plate, refined', reference_indexes: [2] }));
    const { images } = await Planner.planBeatSceneImages({ beat, referenceInputs });
    expect(images[0].prompt).toBe('theater plate, refined');
    expect(images[0].reference_image_ids).toEqual(['b'.repeat(24)]);
  });

  it('divide shots carry their own reference assignments', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'Both', prompt: 'both things', justification: '', quote: '', reference_indexes: [1] },
    ]));
    Planner._setScenePlateCritiqueForTests(async () => ({
      verdict: 'divide',
      shots: [
        { name: 'Starfield', prompt: 'milky way', justification: '', quote: '', reference_indexes: [] },
        { name: 'Theater', prompt: 'theater below the stars', justification: '', quote: '', reference_indexes: [1] },
      ],
    }));
    const { images } = await Planner.planBeatSceneImages({ beat, referenceInputs });
    expect(images.find((i) => i.name === 'Starfield').reference_image_ids).toEqual([]);
    expect(images.find((i) => i.name === 'Theater').reference_image_ids).toEqual(['a'.repeat(24)]);
  });

  it('an edit verdict can flip requires_reference; divide shots carry their own flag', async () => {
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'a', justification: '', quote: '', requires_reference: false },
      { name: 'B', prompt: 'b', justification: '', quote: '', requires_reference: true },
    ]));
    Planner._setScenePlateCritiqueForTests(async (plate) => {
      if (plate.name === 'A') return { verdict: 'edit', requires_reference: true };
      return {
        verdict: 'divide',
        shots: [
          { name: 'B1', prompt: 'b1', justification: '', quote: '', requires_reference: false },
          { name: 'B2', prompt: 'b2', justification: '', quote: '' },
        ],
      };
    });
    const { images } = await Planner.planBeatSceneImages({ beat });
    expect(images.find((i) => i.name === 'A').requires_reference).toBe(true);
    expect(images.find((i) => i.name === 'B1').requires_reference).toBe(false);
    // Divide shot without its own flag inherits the parent's.
    expect(images.find((i) => i.name === 'B2').requires_reference).toBe(true);
  });

  it('passes referenceInputs to the phase-2 critique context', async () => {
    let p2ctx = null;
    Planner._setScenePlatePlannerForTests(async () => ([
      { name: 'A', prompt: 'a', justification: '', quote: '', reference_indexes: [1] },
    ]));
    Planner._setScenePlateCritiqueForTests(async (_plate, ctx) => {
      p2ctx = ctx;
      return { verdict: 'keep' };
    });
    await Planner.planBeatSceneImages({ beat, referenceInputs });
    expect(p2ctx.referenceInputs).toBe(referenceInputs);
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
  it('exposes plan_scene_plates requiring name/prompt/justification/quote/requires_reference', () => {
    expect(Planner.SCENE_PLATE_PLAN_TOOL.name).toBe('plan_scene_plates');
    const item = Planner.SCENE_PLATE_PLAN_TOOL.input_schema.properties.plates.items;
    expect(item.required.sort()).toEqual(['justification', 'name', 'prompt', 'quote', 'requires_reference']);
    expect(item.properties.requires_reference.type).toBe('boolean');
    expect(Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT.toLowerCase()).toMatch(/background|environment|plate|location/);
  });

  it('plan prompt explains when a plate requires a reference (established look vs standalone)', () => {
    const t = Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT.toLowerCase();
    expect(t).toContain('requires_reference');
    expect(t).toMatch(/established|continuity/);
  });

  it('critique tool can flip requires_reference and its prompt covers the flag', () => {
    const props = Planner.SCENE_PLATE_CRITIQUE_TOOL.input_schema.properties;
    expect(props.requires_reference.type).toBe('boolean');
    expect(Planner.SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT.toLowerCase()).toContain('requires_reference');
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

  it('plan tool lets each plate assign reference images by index', () => {
    const item = Planner.SCENE_PLATE_PLAN_TOOL.input_schema.properties.plates.items;
    expect(item.properties.reference_indexes.type).toBe('array');
    expect(item.properties.reference_indexes.items.type).toBe('integer');
    expect(item.required).not.toContain('reference_indexes');
  });

  it('plan prompt demands minimal planning and per-plate reference assignment with stated roles', () => {
    const t = Planner.SCENE_PLATE_PLAN_SYSTEM_PROMPT.toLowerCase();
    expect(t).toContain('fewest plates');
    expect(t).not.toContain('vary the scale');
    expect(t).toContain('reference_indexes');
    // A plate's prompt must say what its assigned references contribute.
    expect(t).toMatch(/reference[^.]*\brole\b/);
  });

  it('critique tool can reassign references on edit, and the prompt has a reference check', () => {
    const props = Planner.SCENE_PLATE_CRITIQUE_TOOL.input_schema.properties;
    expect(props.reference_indexes.type).toBe('array');
    expect(Planner.SCENE_PLATE_CRITIQUE_SYSTEM_PROMPT.toLowerCase()).toContain('reference check');
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
