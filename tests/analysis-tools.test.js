import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');

beforeEach(() => {
  fakeDb.reset();
});

async function seedBeats(beats) {
  for (const b of beats) {
    await Plots.createBeat(b);
  }
}

describe('find_repeated_phrases', () => {
  it('returns ranked phrases with sources for repeated 2- and 3-grams', async () => {
    const repeated = 'she walked quietly into the diner';
    const beats = [];
    for (let i = 0; i < 12; i++) {
      beats.push({
        name: `Beat ${i}`,
        desc: `${repeated} with backstory ${i}`,
        body: `${repeated} ${repeated}`,
      });
    }
    await seedBeats(beats);
    const out = JSON.parse(await HANDLERS.find_repeated_phrases({}));
    expect(out.status).toBe('ok');
    expect(out.beats_scanned).toBe(12);
    const walked = out.phrases.find((p) => p.gram === 'walked quietly');
    expect(walked).toBeDefined();
    expect(walked.count).toBeGreaterThanOrEqual(12);
    expect(walked.sources.length).toBeLessThanOrEqual(5);
  });

  it('returns low_signal when fewer than 10 beats but still computes', async () => {
    await seedBeats([
      { name: 'A', desc: 'she said quietly while turning to leave' },
      { name: 'B', desc: 'she said quietly while sitting down' },
    ]);
    const out = JSON.parse(await HANDLERS.find_repeated_phrases({}));
    expect(out.status).toBe('low_signal');
    expect(out.note).toMatch(/unreliable/);
    expect(out.phrases.find((p) => p.gram === 'said quietly')).toBeDefined();
  });

  it('returns empty status when no beats exist', async () => {
    const out = JSON.parse(await HANDLERS.find_repeated_phrases({}));
    expect(out.status).toBe('empty');
  });

  it('respects fields option (name only, body only, etc.)', async () => {
    await seedBeats([
      { name: 'Beat A', desc: 'forest forest forest', body: 'mountain mountain' },
      { name: 'Beat B', desc: 'forest forest forest', body: 'mountain mountain' },
    ]);
    const out = JSON.parse(
      await HANDLERS.find_repeated_phrases({ fields: ['body'], sizes: [2] }),
    );
    expect(out.fields_scanned).toEqual(['body']);
    expect(out.phrases.find((p) => p.gram === 'mountain mountain')).toBeDefined();
    expect(out.phrases.find((p) => p.gram === 'forest forest')).toBeUndefined();
  });
});

describe('check_similarity', () => {
  it('finds a near-duplicate character via candidate text', async () => {
    await Characters.createCharacter({
      name: 'Marcus',
      plays_self: true,
      own_voice: true,
      fields: {
        background_story: 'A grizzled warrior who lost his family in a fire and now seeks vengeance',
        arc: 'Learns to forgive his enemies through unexpected friendship',
      },
    });
    await Characters.createCharacter({
      name: 'Beatrice',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'A baker who runs a quiet shop in a small village' },
    });
    const out = JSON.parse(
      await HANDLERS.check_similarity({
        target_type: 'character',
        text: 'A grizzled warrior who lost his family in a fire seeking vengeance',
        threshold: 0.5,
      }),
    );
    expect(out.matches.length).toBeGreaterThan(0);
    expect(out.matches[0].label).toBe('Marcus');
    expect(out.matches[0].score).toBeGreaterThan(0.5);
  });

  it('excludes the target when called in existing-mode', async () => {
    await Characters.createCharacter({
      name: 'Marcus',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a grizzled warrior who lost his family' },
    });
    await Characters.createCharacter({
      name: 'Twin',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a grizzled warrior who lost his family' },
    });
    const out = JSON.parse(
      await HANDLERS.check_similarity({
        target_type: 'character',
        identifier: 'Marcus',
        threshold: 0.5,
      }),
    );
    expect(out.matches.find((m) => m.label === 'Marcus')).toBeUndefined();
    expect(out.matches.find((m) => m.label === 'Twin')).toBeDefined();
  });

  it('returns no_corpus when only one item exists', async () => {
    await Characters.createCharacter({
      name: 'Solo',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'a lone wanderer' },
    });
    const out = JSON.parse(
      await HANDLERS.check_similarity({
        target_type: 'character',
        identifier: 'Solo',
      }),
    );
    expect(out.status).toBe('no_corpus');
  });

  it('rejects mutually exclusive identifier+text', async () => {
    const out = await HANDLERS.check_similarity({
      target_type: 'character',
      identifier: 'whatever',
      text: 'whatever',
    });
    expect(out).toMatch(/identifier.*OR.*text/i);
  });

  it('rejects missing target_type', async () => {
    const out = await HANDLERS.check_similarity({ text: 'hi' });
    expect(out).toMatch(/target_type/);
  });

  it('works for beats too', async () => {
    await seedBeats([
      { name: 'Diner Argument', desc: 'Alice and Bob argue about the past at the diner' },
      { name: 'Park Walk', desc: 'Alice walks through the park alone after work' },
    ]);
    const out = JSON.parse(
      await HANDLERS.check_similarity({
        target_type: 'beat',
        text: 'Alice and Bob argue about the past',
        threshold: 0.4,
      }),
    );
    expect(out.matches.find((m) => /Diner Argument/.test(m.label))).toBeDefined();
  });
});

describe('find_character_phrases', () => {
  it('returns top n-grams across beats featuring the character', async () => {
    await Characters.createCharacter({
      name: 'Alice',
      plays_self: true,
      own_voice: true,
      fields: {},
    });
    await seedBeats([
      {
        name: 'Doubt 1',
        desc: 'alice doubts herself before the meeting',
        body: 'alice doubts herself again later',
        characters: ['Alice'],
      },
      {
        name: 'Doubt 2',
        desc: 'alice doubts herself in the mirror',
        body: 'alice doubts everything around her',
        characters: ['Alice'],
      },
      {
        name: 'No Alice',
        desc: 'bob walks alone through the park',
        characters: ['Bob'],
      },
    ]);
    const out = JSON.parse(
      await HANDLERS.find_character_phrases({ character: 'Alice', sizes: [2] }),
    );
    expect(out.status).toBe('ok');
    expect(out.beats_featuring).toBe(2);
    expect(out.total_beats).toBe(3);
    expect(out.phrases_by_size.size_2.find((p) => p.gram === 'alice doubts')).toBeDefined();
  });

  it('returns no_beats when character has no associated beats', async () => {
    await Characters.createCharacter({
      name: 'Lonely',
      plays_self: true,
      own_voice: true,
      fields: {},
    });
    await seedBeats([{ name: 'Other', desc: 'unrelated', characters: ['Bob'] }]);
    const out = JSON.parse(await HANDLERS.find_character_phrases({ character: 'Lonely' }));
    expect(out.status).toBe('no_beats');
    expect(out.message).toMatch(/link_character_to_beat/);
  });

  it('returns friendly error for unknown character', async () => {
    const out = await HANDLERS.find_character_phrases({ character: 'Ghost' });
    expect(out).toMatch(/No character found/);
  });

  it('matches characters case-insensitively against beat.characters', async () => {
    await Characters.createCharacter({
      name: 'Marcus',
      plays_self: true,
      own_voice: true,
      fields: {},
    });
    await seedBeats([
      {
        name: 'Lower',
        desc: 'marcus walks through the cathedral courtyard',
        body: 'marcus walks slowly through the silent halls',
        characters: ['marcus'],
      },
      {
        name: 'Upper',
        desc: 'marcus walks through the village square',
        body: 'marcus walks through the marketplace at dusk',
        characters: ['MARCUS'],
      },
    ]);
    const out = JSON.parse(
      await HANDLERS.find_character_phrases({ character: 'Marcus', sizes: [2] }),
    );
    expect(out.beats_featuring).toBe(2);
    expect(out.phrases_by_size.size_2.find((p) => p.gram === 'marcus walks')).toBeDefined();
  });
});

describe('analyze_dramatic_arc', () => {
  it('detects the climax near the end of the arc', async () => {
    await seedBeats([
      { name: 'Setup', desc: 'a calm afternoon', body: 'a calm afternoon' },
      { name: 'Rising 1', desc: 'a calm afternoon', body: 'a calm afternoon' },
      { name: 'Rising 2', desc: 'a calm afternoon', body: 'a calm afternoon' },
      { name: 'Climax', desc: 'terrible terrible tragic horrible', body: 'awful dreadful disaster' },
      { name: 'Resolution', desc: 'a quiet morning', body: 'a quiet morning' },
    ]);
    const out = JSON.parse(await HANDLERS.analyze_dramatic_arc({}));
    expect(out.status).toBe('ok');
    expect(out.climax.beat.name).toBe('Climax');
    expect(out.climax.normalized_position).toBeCloseTo(0.75, 1);
    expect(out.in_expected_window).toBe(true);
  });

  it('returns low_signal for fewer than 3 beats', async () => {
    await seedBeats([{ name: 'A', desc: 'whatever' }, { name: 'B', desc: 'something' }]);
    const out = JSON.parse(await HANDLERS.analyze_dramatic_arc({}));
    expect(out.status).toBe('low_signal');
  });

  it('returns no_signal when sentiment is flat', async () => {
    await seedBeats([
      { name: 'A', desc: 'plain neutral text', body: '' },
      { name: 'B', desc: 'plain neutral text', body: '' },
      { name: 'C', desc: 'plain neutral text', body: '' },
    ]);
    const out = JSON.parse(await HANDLERS.analyze_dramatic_arc({}));
    expect(out.status).toBe('no_signal');
  });

  it('supports steepest_drop metric', async () => {
    await seedBeats([
      { name: 'High1', desc: 'wonderful joyful happy delightful' },
      { name: 'High2', desc: 'wonderful joyful happy delightful' },
      { name: 'High3', desc: 'wonderful joyful happy delightful' },
      { name: 'Crash', desc: 'terrible horrible awful tragic' },
      { name: 'After', desc: 'a quiet ending' },
    ]);
    const out = JSON.parse(
      await HANDLERS.analyze_dramatic_arc({ metric: 'steepest_drop' }),
    );
    expect(out.status).toBe('ok');
    expect(out.metric).toBe('steepest_drop');
    expect(out.climax.beat.name).toBe('Crash');
  });

  it('returns empty when no beats exist', async () => {
    const out = JSON.parse(await HANDLERS.analyze_dramatic_arc({}));
    expect(out.status).toBe('empty');
  });
});
