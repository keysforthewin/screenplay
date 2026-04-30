import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Characters = await import('../src/mongo/characters.js');
const Plots = await import('../src/mongo/plots.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('Characters.deleteCharacter', () => {
  it('removes the character document by name (case-insensitive)', async () => {
    await Characters.createCharacter({ name: 'Alice', plays_self: true, own_voice: true });
    const res = await Characters.deleteCharacter('alice');
    expect(res.name).toBe('Alice');
    expect(await Characters.getCharacter('Alice')).toBe(null);
  });

  it('removes the character document by _id', async () => {
    const c = await Characters.createCharacter({ name: 'Bob', plays_self: true, own_voice: true });
    await Characters.deleteCharacter(c._id.toString());
    expect(await Characters.getCharacter('Bob')).toBe(null);
  });

  it('throws when the character does not exist', async () => {
    await expect(Characters.deleteCharacter('Nobody')).rejects.toThrow(/not found/i);
  });

  it('returns image_ids and attachment_ids for cascade cleanup', async () => {
    const img1 = new ObjectId();
    const img2 = new ObjectId();
    const att1 = new ObjectId();
    await fakeDb.collection('characters').insertOne({
      name: 'Carol',
      name_lower: 'carol',
      plays_self: true,
      own_voice: true,
      hollywood_actor: null,
      fields: {},
      images: [
        { _id: img1, filename: 'a.png', content_type: 'image/png', size: 1, uploaded_at: new Date() },
        { _id: img2, filename: 'b.png', content_type: 'image/png', size: 1, uploaded_at: new Date() },
      ],
      attachments: [
        { _id: att1, filename: 'notes.txt', content_type: 'text/plain', size: 1, uploaded_at: new Date() },
      ],
      created_at: new Date(),
      updated_at: new Date(),
    });

    const res = await Characters.deleteCharacter('Carol');
    expect(res.image_ids.map((x) => x.toString())).toEqual([img1.toString(), img2.toString()]);
    expect(res.attachment_ids.map((x) => x.toString())).toEqual([att1.toString()]);
  });

  it('returns empty image/attachment arrays when the character had none', async () => {
    await Characters.createCharacter({ name: 'Dan', plays_self: true, own_voice: true });
    const res = await Characters.deleteCharacter('Dan');
    expect(res.image_ids).toEqual([]);
    expect(res.attachment_ids).toEqual([]);
  });
});

describe('Plots.unlinkCharacterFromAllBeats', () => {
  it('removes the character (case-insensitive) from every beat that references them', async () => {
    await Plots.createBeat({ name: 'Open', desc: 'd', characters: ['Alice', 'Bob'] });
    await Plots.createBeat({ name: 'Mid', desc: 'd', characters: ['alice', 'Carol'] });
    await Plots.createBeat({ name: 'End', desc: 'd', characters: ['Bob'] });

    const res = await Plots.unlinkCharacterFromAllBeats('Alice');
    expect(res.unlinked_from).toBe(2);

    const beats = await Plots.listBeats();
    expect(beats.find((b) => b.name === 'Open').characters).toEqual(['Bob']);
    expect(beats.find((b) => b.name === 'Mid').characters).toEqual(['Carol']);
    expect(beats.find((b) => b.name === 'End').characters).toEqual(['Bob']);
  });

  it('reports zero when no beats reference the character', async () => {
    await Plots.createBeat({ name: 'Open', desc: 'd', characters: ['Bob'] });
    const res = await Plots.unlinkCharacterFromAllBeats('Alice');
    expect(res.unlinked_from).toBe(0);
  });
});

describe('delete_character handler', () => {
  it('returns a friendly error when the character does not exist', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    const result = await HANDLERS.delete_character({ identifier: 'Ghost' });
    expect(result).toMatch(/no character found/i);
  });

  it('deletes the character and unlinks them from beats', async () => {
    const { HANDLERS } = await import('../src/agent/handlers.js');
    await Characters.createCharacter({ name: 'Eve', plays_self: true, own_voice: true });
    await Plots.createBeat({ name: 'Scene', desc: 'd', characters: ['Eve', 'Frank'] });

    const result = await HANDLERS.delete_character({ identifier: 'eve' });
    expect(result).toMatch(/deleted character "Eve"/i);
    expect(result).toMatch(/unlinked from 1 beat/i);

    expect(await Characters.getCharacter('Eve')).toBe(null);
    const [beat] = await Plots.listBeats();
    expect(beat.characters).toEqual(['Frank']);
  });
});
