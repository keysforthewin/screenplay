import { describe, it, expect, afterEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';

vi.mock('../src/log.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const W = await import('../src/web/wardrobeBackfill.js');
const { WARDROBE_TEXT_MAX } = await import('../src/web/wardrobe.js');

const steve = { _id: new ObjectId(), name: '**Steve Keys**', hollywood_actor: 'Paul Rudd', fields: { age: '41', occupation: 'theatre manager', wardrobe: '' } };
const plot = {
  title: 'Cold Open',
  synopsis: 'A small-town cinema.',
  beats: [
    { _id: new ObjectId(), order: 2, name: 'Lobby', characters: ['Steve Keys'], body: 'INT. LOBBY — NIGHT\n\nSTEVE counts the till.\n\nA kid runs past.' },
    { _id: new ObjectId(), order: 1, name: 'Cold open', characters: ['Steve Keys', 'Mara'], body: 'EXT. LOT — DAY\n\nSTEVE KEYS (41), in a navy windbreaker over a grey tee, crosses the lot.\n\nMARA waits.' },
    { _id: new ObjectId(), order: 3, name: 'Office', characters: [], body: 'INT. OFFICE — DAY\n\nA photo of Steve on the wall. Mara sighs.' },
    { _id: new ObjectId(), order: 4, name: 'Street', characters: ['Mara'], body: 'EXT. STREET — DAY\n\nMara walks. Stevenson Avenue is empty.' },
  ],
};

afterEach(() => W._setWardrobeProposerForTests(null));

describe('wardrobe backfill', () => {
  it('finds the beats carrying a character in script order — roster first, then body mentions, never a longer word', () => {
    const got = W.beatsForCharacter(plot.beats, steve);
    expect(got.map((x) => [x.beat.order, x.rostered])).toEqual([[1, true], [2, true], [3, false]]);
  });

  it('the context names the intro beat and only the later paragraphs that mention the character', () => {
    const ctx = W.collectWardrobeContext({ plot, character: steve });
    expect(ctx.name).toBe('Steve Keys');
    expect(ctx.intro.beat.order).toBe(1);
    expect(ctx.appearanceCount).toBe(3);
    expect(ctx.later.map((l) => [l.beat.order, l.paragraphs])).toEqual([
      [2, ['STEVE counts the till.']],
      [3, ['A photo of Steve on the wall. Mara sighs.']],
    ]);
  });

  it('the prompt carries the card without a wardrobe line, the intro beat whole, and the later paragraphs', () => {
    const prompt = W.buildWardrobePrompt({ plot, character: { ...steve, fields: { ...steve.fields, wardrobe: 'old lock' } } });
    expect(prompt).toContain('# The film: Cold Open');
    expect(prompt).toContain('Steve Keys — played by Paul Rudd');
    expect(prompt).toContain('occupation: theatre manager');
    expect(prompt).not.toContain('old lock');
    expect(prompt).toContain('# The beat that introduces Steve Keys — beat 1 "Cold open"');
    expect(prompt).toContain('navy windbreaker over a grey tee');
    expect(prompt).toContain('# Later, beat 2 "Lobby"');
    expect(prompt).toContain('- STEVE counts the till.');
    expect(prompt).not.toContain('Stevenson');
    expect(prompt.endsWith('Write the locked wardrobe for Steve Keys.')).toBe(true);
  });

  it('a character in no beat is asked for from the card alone', () => {
    const prompt = W.buildWardrobePrompt({ plot, character: { _id: new ObjectId(), name: 'Nobody', fields: {} } });
    expect(prompt).toContain('Nobody is not in any beat yet. Invent the outfit from the card.');
  });

  it('normalizes the answer: one line, clipped to the lock limit, invented when no evidence', () => {
    const long = 'x'.repeat(WARDROBE_TEXT_MAX + 50);
    expect(W.normalizeWardrobeAnswer({ wardrobe: long, invented: false, evidence: [] })).toMatchObject({ invented: true });
    expect(W.normalizeWardrobeAnswer({ wardrobe: long, invented: false, evidence: [] }).wardrobe.length).toBe(WARDROBE_TEXT_MAX);
    const r = W.normalizeWardrobeAnswer({ wardrobe: '**Navy**\nwindbreaker,  grey tee', invented: false, evidence: [{ beat: 'beat 1', quote: ' navy  windbreaker ' }, { quote: '' }] });
    expect(r).toEqual({ wardrobe: 'Navy windbreaker, grey tee', invented: false, evidence: [{ beat: 'beat 1', quote: 'navy windbreaker' }] });
  });

  it('proposeWardrobe runs the prompt through the seam and refuses an empty answer', async () => {
    const seen = [];
    W._setWardrobeProposerForTests(async ({ prompt, slot }) => { seen.push({ prompt, slot }); return { wardrobe: 'Navy windbreaker, grey tee, jeans, white trainers', invented: false, evidence: [{ beat: 'beat 1', quote: 'navy windbreaker over a grey tee' }] }; });
    const r = await W.proposeWardrobe({ plot, character: steve });
    expect(seen[0].slot).toBe('writer');
    expect(seen[0].prompt).toContain('Write the locked wardrobe for Steve Keys.');
    expect(r.wardrobe).toBe('Navy windbreaker, grey tee, jeans, white trainers');
    expect(r.context.intro.beat.order).toBe(1);
    W._setWardrobeProposerForTests(async () => ({ wardrobe: '', invented: true, evidence: [] }));
    await expect(W.proposeWardrobe({ plot, character: steve })).rejects.toThrow(/no wardrobe for Steve Keys/);
  });
});
