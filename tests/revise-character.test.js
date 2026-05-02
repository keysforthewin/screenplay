import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

const analyzeTextMock = vi.fn();
vi.mock('../src/llm/analyze.js', () => ({
  analyzeText: (...args) => analyzeTextMock(...args),
}));

const Characters = await import('../src/mongo/characters.js');
const { HANDLERS } = await import('../src/agent/handlers.js');

beforeEach(() => {
  fakeDb.reset();
  analyzeTextMock.mockReset();
});

describe('revise_character handler', () => {
  it('applies edits and deletes from the LLM response in one updateCharacter call', async () => {
    await Characters.createCharacter({
      name: 'Baezil',
      fields: {
        bio: 'Baezil joined the Pre-beat-5 (South Pole Heist) crew last winter.',
        'Pre-beat-5 (South Pole Heist)': 'Full account of the South Pole heist.',
        role: 'antagonist',
      },
    });
    analyzeTextMock.mockResolvedValue(
      JSON.stringify({
        actions: [
          { field: 'bio', action: 'edit', new_value: 'Baezil joined the crew last winter.' },
          { field: 'Pre-beat-5 (South Pole Heist)', action: 'delete' },
          { field: 'role', action: 'keep' },
        ],
      }),
    );

    const out = await HANDLERS.revise_character({
      identifier: 'Baezil',
      instructions: 'Remove all references to Pre-beat-5 (South Pole Heist).',
    });

    expect(out).toMatch(/Revised Baezil/);
    expect(out).toMatch(/edited: bio/);
    expect(out).toMatch(/removed: Pre-beat-5/);
    expect(out).toMatch(/unchanged: 1 field/);

    const fresh = await Characters.getCharacter('Baezil');
    expect(fresh.fields.bio).toBe('Baezil joined the crew last winter.');
    expect('Pre-beat-5 (South Pole Heist)' in fresh.fields).toBe(false);
    expect(fresh.fields.role).toBe('antagonist');
  });

  it('tolerates a code-fenced JSON response from the LLM', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: { bio: 'old text' } });
    analyzeTextMock.mockResolvedValue(
      '```json\n' +
        JSON.stringify({ actions: [{ field: 'bio', action: 'edit', new_value: 'new text' }] }) +
        '\n```',
    );

    const out = await HANDLERS.revise_character({
      identifier: 'Alice',
      instructions: 'rewrite the bio',
    });
    expect(out).toMatch(/edited: bio/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields.bio).toBe('new text');
  });

  it('ignores hallucinated field names not present on the character', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: { bio: 'x' } });
    analyzeTextMock.mockResolvedValue(
      JSON.stringify({
        actions: [
          { field: 'bio', action: 'keep' },
          { field: 'some_made_up_field', action: 'edit', new_value: 'whatever' },
          { field: 'another_invented_one', action: 'delete' },
        ],
      }),
    );

    const out = await HANDLERS.revise_character({
      identifier: 'Alice',
      instructions: 'do nothing harmful',
    });
    expect(out).toMatch(/no changes/);
    const fresh = await Characters.getCharacter('Alice');
    expect(fresh.fields).toEqual({ bio: 'x' });
    expect('some_made_up_field' in fresh.fields).toBe(false);
  });

  it('returns "no changes" when every action is keep', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: { bio: 'x', role: 'y' } });
    analyzeTextMock.mockResolvedValue(
      JSON.stringify({
        actions: [
          { field: 'bio', action: 'keep' },
          { field: 'role', action: 'keep' },
        ],
      }),
    );
    const out = await HANDLERS.revise_character({
      identifier: 'Alice',
      instructions: 'leave it alone',
    });
    expect(out).toMatch(/no changes/);
    expect(out).toMatch(/all 2 field/);
  });

  it('returns the no-fields message when character has no custom fields', async () => {
    await Characters.createCharacter({ name: 'Alice' });
    const out = await HANDLERS.revise_character({
      identifier: 'Alice',
      instructions: 'try anything',
    });
    expect(out).toMatch(/no custom fields to revise/);
    expect(analyzeTextMock).not.toHaveBeenCalled();
  });

  it('returns a parse-error message on malformed LLM JSON', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: { bio: 'x' } });
    analyzeTextMock.mockResolvedValue('this is not JSON at all');
    const out = await HANDLERS.revise_character({
      identifier: 'Alice',
      instructions: 'try',
    });
    expect(out).toMatch(/could not parse LLM response/);
  });

  it('returns a friendly error string when analyzeText throws', async () => {
    await Characters.createCharacter({ name: 'Alice', fields: { bio: 'x' } });
    analyzeTextMock.mockRejectedValue(new Error('API key missing'));
    const out = await HANDLERS.revise_character({
      identifier: 'Alice',
      instructions: 'try',
    });
    expect(out).toMatch(/LLM call failed: API key missing/);
  });

  it('rejects missing identifier or instructions', async () => {
    expect(await HANDLERS.revise_character({ instructions: 'x' })).toMatch(/identifier is required/);
    expect(await HANDLERS.revise_character({ identifier: 'A' })).toMatch(/instructions is required/);
    expect(await HANDLERS.revise_character({ identifier: 'A', instructions: '   ' })).toMatch(
      /instructions is required/,
    );
  });

  it('returns "Character not found" for an unknown identifier', async () => {
    const out = await HANDLERS.revise_character({
      identifier: 'Nobody',
      instructions: 'x',
    });
    expect(out).toMatch(/Character not found: Nobody/);
  });
});
