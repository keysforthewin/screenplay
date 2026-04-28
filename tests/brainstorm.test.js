import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('rapid-fire brainstorm: stub character + beats + rename', () => {
  it('stub character can be linked at beat-create time and survives a later rename, with documented drift', async () => {
    // T2 from scenario D: a streamer kid is referenced descriptively, no real
    // name yet. Stub now, rename later.
    const kid = await Characters.createCharacter({ name: 'Streamer Kid' });
    expect(kid.name_lower).toBe('streamer kid');

    // Create beat 2 (the shooting one), linked at create time using the stub name.
    const beat = await Plots.createBeat({
      name: 'Kid Shoots Nully',
      desc: 'The wipe where a streamer kid shot Nully.',
      characters: ['Nully', 'Streamer Kid'],
    });
    expect(beat.characters).toEqual(['Nully', 'Streamer Kid']);

    // Later turn: user reveals the kid's actual name.
    const renamed = await Characters.updateCharacter(kid._id.toString(), { name: 'Marcus' });
    expect(renamed.name).toBe('Marcus');
    expect(renamed.name_lower).toBe('marcus');

    // DOCUMENTED LIMITATION: beat.characters is a string array, not _id refs.
    // The rename does NOT propagate. The model is told (in systemPrompt) to
    // explicitly call update_beat to fix references after a rename.
    const beatStaleLink = await Plots.getBeat(beat._id.toString());
    expect(beatStaleLink.characters).toEqual(['Nully', 'Streamer Kid']);

    // Apply the corrective update_beat the model is supposed to issue.
    await Plots.updateBeat(beat._id.toString(), { characters: ['Nully', 'Marcus'] });
    const beatFixed = await Plots.getBeat(beat._id.toString());
    expect(beatFixed.characters).toEqual(['Nully', 'Marcus']);
  });

  it('parallel-creation shape: characters then beats with link arg in one logical batch lands intact', async () => {
    // Mirrors what the model emits in one assistant turn for scenario D, T1+T2:
    // four parallel tool_uses. The dispatch loop runs them sequentially in JS
    // but they all complete in the same Anthropic round-trip.
    await Characters.createCharacter({ name: 'Nully' });
    await Characters.createCharacter({ name: 'Streamer Kid' });
    const b1 = await Plots.createBeat({
      name: 'Nully Despawns Base',
      desc: 'The time Nully despawned the base.',
      characters: ['Nully'],
    });
    const b2 = await Plots.createBeat({
      name: 'Kid Shoots Nully',
      desc: 'The wipe where a streamer kid shot Nully.',
      characters: ['Nully', 'Streamer Kid'],
    });

    const all = await Plots.listBeats();
    expect(all).toHaveLength(2);
    expect(all[0]._id.equals(b1._id)).toBe(true);
    expect(all[1]._id.equals(b2._id)).toBe(true);
    expect(all[0].characters).toEqual(['Nully']);
    expect(all[1].characters).toEqual(['Nully', 'Streamer Kid']);

    // First-created beat auto-becomes current; mid-brainstorm focus tracking
    // is supposed to NOT flip this — that's a model-prompt rule, but the
    // backing pointer should still remain on b1 after b2 was created.
    const cur = await Plots.getCurrentBeat();
    expect(cur._id.equals(b1._id)).toBe(true);
  });

  it('character search by name still works after rename (sanity for stub-then-rename flow)', async () => {
    await Characters.createCharacter({ name: 'Streamer Kid' });
    const got1 = await Characters.getCharacter('streamer kid');
    expect(got1).toBeTruthy();

    await Characters.updateCharacter('Streamer Kid', { name: 'Marcus' });
    const got2 = await Characters.getCharacter('marcus');
    expect(got2).toBeTruthy();
    expect(got2.name).toBe('Marcus');

    // Old name no longer resolves — good, it's been renamed.
    const got3 = await Characters.getCharacter('streamer kid');
    expect(got3).toBeNull();
  });
});
