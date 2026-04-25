import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const { buildOverview } = await import('../src/agent/overview.js');

beforeEach(() => {
  fakeDb.reset();
});

async function seedTemplate() {
  await fakeDb.collection('prompts').insertOne({
    _id: 'character_template',
    fields: [
      { name: 'name', description: 'name', required: true, core: true },
      { name: 'plays_self', description: 'self', required: true, core: true },
      { name: 'hollywood_actor', description: 'actor', required: false, core: true },
      { name: 'own_voice', description: 'voice', required: true, core: true },
      { name: 'background_story', description: 'bg', required: true, core: false },
      { name: 'arc', description: 'arc', required: true, core: false },
      { name: 'memes', description: 'memes', required: false, core: false },
    ],
    updated_at: new Date(),
  });
}

describe('buildOverview', () => {
  it('handles fully empty state', async () => {
    await seedTemplate();
    const o = await buildOverview();
    expect(o.plot.synopsis).toBe('');
    expect(o.plot.synopsis_filled).toBe(false);
    expect(o.plot.current_beat).toBe(null);
    expect(o.counts).toEqual({
      characters: 0,
      characters_with_main_image: 0,
      beats: 0,
      beats_with_body: 0,
      beats_with_main_image: 0,
    });
    expect(o.characters).toEqual([]);
    expect(o.beats).toEqual([]);
    expect(o.character_template_fields).toEqual(['background_story', 'arc', 'memes']);
  });

  it('summarizes a populated screenplay', async () => {
    await seedTemplate();
    await Plots.updatePlot({ synopsis: 'A test story.', notes: 'some notes' });

    await Characters.createCharacter({
      name: 'Alice',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'A long backstory about Alice.', arc: 'Grows.' },
    });
    await Characters.createCharacter({
      name: 'Bob',
      plays_self: false,
      hollywood_actor: 'Cillian Murphy',
      own_voice: false,
      fields: {},
    });

    const beat1 = await Plots.createBeat({ name: 'Open', desc: 'Opening scene', body: 'lots of words' });
    await Plots.createBeat({ name: 'Climax', desc: 'They fight.', characters: ['Alice', 'Bob'] });
    await Plots.setCurrentBeat(beat1._id.toString());

    const o = await buildOverview();

    expect(o.plot.synopsis).toBe('A test story.');
    expect(o.plot.synopsis_filled).toBe(true);
    expect(o.plot.current_beat).toEqual({
      _id: beat1._id.toString(),
      order: 1,
      name: 'Open',
    });
    expect(o.counts.characters).toBe(2);
    expect(o.counts.beats).toBe(2);
    expect(o.counts.beats_with_body).toBe(1);

    const alice = o.characters.find((c) => c.name === 'Alice');
    expect(alice.casting).toBe('plays self');
    expect(alice.own_voice).toBe(true);
    expect(alice.flavor.field).toBe('background_story');
    expect(alice.flavor.preview).toContain('long backstory');
    expect(alice.filled_field_count).toBe(2);
    expect(alice.total_field_count).toBe(3);
    expect(alice.has_main_image).toBe(false);

    const bob = o.characters.find((c) => c.name === 'Bob');
    expect(bob.casting).toBe('played by Cillian Murphy');
    expect(bob.own_voice).toBe(false);
    expect(bob.flavor).toBe(null);
    expect(bob.filled_field_count).toBe(0);

    const open = o.beats.find((b) => b.name === 'Open');
    expect(open.is_current).toBe(true);
    expect(open.body_length).toBe('lots of words'.length);
    expect(open.has_body).toBe(true);

    const climax = o.beats.find((b) => b.name === 'Climax');
    expect(climax.is_current).toBe(false);
    expect(climax.has_body).toBe(false);
    expect(climax.characters).toEqual(['Alice', 'Bob']);
  });

  it('counts main images on both characters and beats', async () => {
    await seedTemplate();
    const alice = await Characters.createCharacter({
      name: 'Alice', plays_self: true, own_voice: true, fields: {},
    });
    const beat = await Plots.createBeat({ name: 'B', desc: 'd' });

    const charImgId = new ObjectId();
    await fakeDb.collection('characters').updateOne(
      { _id: alice._id },
      { $set: { main_image_id: charImgId, images: [{ _id: charImgId }] } },
    );
    await Plots.pushBeatImage(beat._id.toString(), {
      _id: new ObjectId(),
      filename: 'x.png',
      content_type: 'image/png',
      size: 1,
      uploaded_at: new Date(),
    });

    const o = await buildOverview();
    expect(o.counts.characters_with_main_image).toBe(1);
    expect(o.counts.beats_with_main_image).toBe(1);
    expect(o.characters[0].has_main_image).toBe(true);
    expect(o.beats[0].has_main_image).toBe(true);
  });
});
