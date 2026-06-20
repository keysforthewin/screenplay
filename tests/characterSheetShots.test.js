// Unit tests for the static character-sheet shot template + prompt composer.
// Pure functions — no Mongo / provider. The mocks below only exist because the
// module reuses a couple of formatting helpers re-exported from
// storyboardGenerate.js, whose import graph touches the mongo client/log.
import { describe, it, expect, vi } from 'vitest';

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

const {
  CHARACTER_SHEET_SHOTS,
  CHARACTER_SHEET_STYLE_PREAMBLE,
  buildCharacterShotPrompt,
  buildCharacterSheetShots,
  selectSheetShots,
} = await import('../src/web/characterSheetShots.js');

describe('character sheet shot preset', () => {
  it('is a non-empty list of {name, fragment}', () => {
    expect(Array.isArray(CHARACTER_SHEET_SHOTS)).toBe(true);
    expect(CHARACTER_SHEET_SHOTS.length).toBeGreaterThanOrEqual(8);
    for (const s of CHARACTER_SHEET_SHOTS) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.fragment).toBe('string');
      expect(s.fragment.length).toBeGreaterThan(0);
    }
  });

  it('includes a from-behind / back-of-head shot (per the brief)', () => {
    const joined = CHARACTER_SHEET_SHOTS.map((s) => `${s.name} ${s.fragment}`)
      .join(' ')
      .toLowerCase();
    expect(joined).toMatch(/back|behind/);
  });
});

describe('buildCharacterShotPrompt', () => {
  const shot = { name: 'Front headshot', fragment: 'tight head-and-shoulders headshot facing camera' };

  it('embeds the style preamble, the shot fragment, and the actor likeness', () => {
    const character = { name: 'Zorblax', hollywood_actor: 'Zendaya', fields: { description: 'tall, freckled' } };
    const prompt = buildCharacterShotPrompt({ character, shot, directorNotes: [] });
    expect(prompt).toContain(CHARACTER_SHEET_STYLE_PREAMBLE);
    expect(prompt).toContain('tight head-and-shoulders headshot facing camera');
    expect(prompt).toContain('Zendaya');
  });

  it('never embeds the character proper name', () => {
    const character = { name: 'Zorblax', hollywood_actor: 'Zendaya', fields: { description: 'tall' } };
    const prompt = buildCharacterShotPrompt({ character, shot });
    expect(prompt).not.toContain('Zorblax');
  });

  it('omits actor likeness for voice-only casting and leans on the look field', () => {
    const character = {
      name: 'Nemo',
      hollywood_actor: 'Albert Brooks (voice only)',
      fields: { description: 'an orange clownfish with a lucky fin' },
    };
    const prompt = buildCharacterShotPrompt({ character, shot });
    expect(prompt).not.toContain('Albert Brooks');
    expect(prompt).toContain('orange clownfish');
  });

  it('folds director notes in as global style guidance', () => {
    const character = { name: 'X', hollywood_actor: 'Zendaya', fields: {} };
    const prompt = buildCharacterShotPrompt({
      character,
      shot,
      directorNotes: [{ text: 'Gritty neo-noir palette' }],
    });
    expect(prompt).toContain('Gritty neo-noir palette');
  });

  it('scans arbitrary custom fields into the prompt context', () => {
    const character = {
      name: 'X',
      hollywood_actor: 'Zendaya',
      fields: { wardrobe: 'red leather jacket', scar: 'left eyebrow' },
    };
    const prompt = buildCharacterShotPrompt({ character, shot });
    expect(prompt).toContain('red leather jacket');
    expect(prompt).toContain('left eyebrow');
  });

  it('forbids overlay/caption text but preserves text on clothing', () => {
    const character = { name: 'X', hollywood_actor: 'Zendaya', fields: {} };
    const prompt = buildCharacterShotPrompt({ character, shot });
    expect(prompt).toMatch(/ONE image of ONE person/i);
    expect(prompt).toMatch(/not a character sheet/i);
    expect(prompt).toMatch(/grid/i);
    // forbids ADDED captions / labels / watermarks…
    expect(prompt).toMatch(/captions|labels|watermark/i);
    // …but explicitly keeps text/logos that belong on the subject's clothing
    expect(prompt).toMatch(/clothing|logos|brand/i);
    // The image itself must never be described as a "reference sheet image" —
    // that phrasing is what made the model emit multi-panel sheets.
    expect(prompt).not.toMatch(/reference sheet image/i);
  });
});

describe('expanded preset', () => {
  it('has at least 24 shots', () => {
    expect(CHARACTER_SHEET_SHOTS.length).toBeGreaterThanOrEqual(24);
  });

  it('includes a rich set of distinct expression/emotion shots', () => {
    const expressions = CHARACTER_SHEET_SHOTS.filter((s) =>
      /smile|laugh|anger|sad|sorrow|surpris|fear|pensive|smirk|disgust|confiden|intense/i.test(
        `${s.name} ${s.fragment}`,
      ),
    );
    expect(expressions.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps every shot name unique', () => {
    const names = CHARACTER_SHEET_SHOTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('selectSheetShots / shotNames', () => {
  it('filters to the named shots in canonical preset order', () => {
    const names = [CHARACTER_SHEET_SHOTS[2].name, CHARACTER_SHEET_SHOTS[0].name];
    const picked = selectSheetShots({ shotNames: names });
    expect(picked.map((s) => s.name)).toEqual([
      CHARACTER_SHEET_SHOTS[0].name,
      CHARACTER_SHEET_SHOTS[2].name,
    ]);
  });

  it('returns [] when shotNames is an empty array', () => {
    expect(selectSheetShots({ shotNames: [] })).toEqual([]);
  });

  it('falls back to a shotCount slice when shotNames is omitted', () => {
    expect(selectSheetShots({ shotCount: 2 })).toHaveLength(2);
    expect(selectSheetShots({})).toHaveLength(CHARACTER_SHEET_SHOTS.length);
  });

  it('buildCharacterSheetShots honors shotNames (preset order)', () => {
    const character = { name: 'X', hollywood_actor: 'Zendaya', fields: {} };
    const front = CHARACTER_SHEET_SHOTS[0].name;
    const back = CHARACTER_SHEET_SHOTS.find((s) => /back of head/i.test(s.name)).name;
    const shots = buildCharacterSheetShots({ character, shotNames: [back, front] });
    expect(shots.map((s) => s.name)).toEqual([front, back]);
  });
});

describe('buildCharacterSheetShots', () => {
  const character = { name: 'X', hollywood_actor: 'Zendaya', fields: {} };

  it('slices to shotCount and returns {name, prompt} entries', () => {
    const shots = buildCharacterSheetShots({ character, shotCount: 3 });
    expect(shots).toHaveLength(3);
    for (const s of shots) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.prompt).toBe('string');
      expect(s.prompt.length).toBeGreaterThan(0);
    }
    expect(shots[0].name).toBe(CHARACTER_SHEET_SHOTS[0].name);
  });

  it('defaults to the full preset when shotCount is omitted', () => {
    const shots = buildCharacterSheetShots({ character });
    expect(shots).toHaveLength(CHARACTER_SHEET_SHOTS.length);
  });

  it('clamps an over-large shotCount to the preset length', () => {
    const shots = buildCharacterSheetShots({ character, shotCount: 999 });
    expect(shots).toHaveLength(CHARACTER_SHEET_SHOTS.length);
  });
});
