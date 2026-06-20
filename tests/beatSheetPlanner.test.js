// Unit tests for the beat scene-image planner. The real Anthropic call is
// covered by the test seam (_setSceneImagePlannerForTests); the normalize/guard
// logic and the user-message builder are tested directly.
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

beforeEach(() => {
  Planner._setSceneImagePlannerForTests(null);
});

describe('buildSceneImagePlanUserText', () => {
  const beat = {
    order: 3,
    name: 'The Alley',
    desc: 'A chase ends.',
    body: 'INT. ALLEY - NIGHT\nRain falls.',
    characters: ['Rae'],
  };

  it('includes the beat context, director notes, the target count, and reference descriptions', () => {
    const text = Planner.buildSceneImagePlanUserText({
      beat,
      characters: [],
      direction: '',
      directorNotes: [{ text: 'Neo-noir mood' }],
      referenceInputs: [{ name: 'alley ref', description: 'wet brick alley at night' }],
      targetCount: 6,
    });
    expect(text).toContain('The Alley');
    expect(text).toContain('Rain falls.');
    expect(text).toContain('Neo-noir mood');
    expect(text).toContain('wet brick alley at night');
    expect(text).toMatch(/\b6\b/);
  });

  it('omits the reference block when there are no reference inputs', () => {
    const text = Planner.buildSceneImagePlanUserText({ beat, characters: [], referenceInputs: [], targetCount: 6 });
    expect(text.toLowerCase()).not.toContain('reference images provided');
  });
});

describe('normalizeScenePlanImages', () => {
  it('drops entries missing name or prompt and trims the rest', () => {
    const out = Planner.normalizeScenePlanImages(
      [
        { name: '  Wide  ', prompt: '  a wide shot  ' },
        { name: 'no prompt' },
        { prompt: 'no name' },
        { name: 'Insert', prompt: 'a detail' },
      ],
      { max: 10 },
    );
    expect(out).toEqual([
      { name: 'Wide', prompt: 'a wide shot' },
      { name: 'Insert', prompt: 'a detail' },
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

describe('planBeatSceneImages (via test seam)', () => {
  const beat = { order: 1, name: 'B', desc: '', body: '', characters: [] };

  it('returns normalized images from the planner override', async () => {
    Planner._setSceneImagePlannerForTests(async () => ({
      images: [
        { name: 'Establishing', prompt: 'wide empty alley, dusk' },
        { name: '', prompt: 'dropped — no name' },
      ],
    }));
    const { images } = await Planner.planBeatSceneImages({ beat, characters: [], targetCount: 8 });
    expect(images).toEqual([{ name: 'Establishing', prompt: 'wide empty alley, dusk' }]);
  });

  it('clamps planner output to MAX_SCENE_IMAGE_COUNT', async () => {
    Planner._setSceneImagePlannerForTests(async () => ({
      images: Array.from({ length: 50 }, (_, i) => ({ name: `n${i}`, prompt: `p${i}` })),
    }));
    const { images } = await Planner.planBeatSceneImages({ beat, characters: [], targetCount: 8 });
    expect(images.length).toBeLessThanOrEqual(Planner.MAX_SCENE_IMAGE_COUNT);
  });

  it('returns { images: [] } when the planner yields nothing', async () => {
    Planner._setSceneImagePlannerForTests(async () => ({ images: [] }));
    const { images } = await Planner.planBeatSceneImages({ beat, characters: [], targetCount: 8 });
    expect(images).toEqual([]);
  });
});

describe('SCENE_IMAGE_PLAN tool + system prompt', () => {
  it('exposes a plan_scene_images tool targeting environment/background plates', () => {
    expect(Planner.SCENE_IMAGE_PLAN_TOOL.name).toBe('plan_scene_images');
    expect(Planner.SCENE_IMAGE_PLAN_SYSTEM_PROMPT.toLowerCase()).toMatch(/background|environment|plate|location/);
  });
});
