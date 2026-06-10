import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const Projects = await import('../src/mongo/projects.js');
const { buildOverview } = await import('../src/agent/overview.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  projectId = (await createProject('Test Project'))._id.toString();
});

async function seedTemplate() {
  const def = await Projects.getDefaultProject();
  await fakeDb.collection('prompts').insertOne({
    _id: `${def._id.toString()}:character_template`,
    fields: [
      { name: 'name', description: 'name', required: true, core: true },
      { name: 'hollywood_actor', description: 'actor', required: false, core: true },
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
    const o = await buildOverview(projectId);
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
    await Plots.updatePlot(projectId, { synopsis: 'A test story.', notes: 'some notes' });

    await Characters.createCharacter({ projectId,
      name: 'Alice',
      fields: { background_story: 'A long backstory about Alice.', arc: 'Grows.' },
    });
    await Characters.createCharacter({ projectId,
      name: 'Bob',
      hollywood_actor: 'Cillian Murphy',
      fields: {},
    });

    const beat1 = await Plots.createBeat({ projectId, name: 'Open', desc: 'Opening scene', body: 'lots of words' });
    await Plots.createBeat({ projectId, name: 'Climax', desc: 'They fight.', characters: ['Alice', 'Bob'] });
    await Plots.setCurrentBeat(projectId, beat1._id.toString());

    const o = await buildOverview(projectId);

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
    expect(alice.casting).toBe('no actor assigned');
    expect(alice.flavor.field).toBe('background_story');
    expect(alice.flavor.preview).toContain('long backstory');
    expect(alice.filled_field_count).toBe(2);
    expect(alice.total_field_count).toBe(3);
    expect(alice.has_main_image).toBe(false);

    const bob = o.characters.find((c) => c.name === 'Bob');
    expect(bob.casting).toBe('played by Cillian Murphy');
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
    const alice = await Characters.createCharacter({ projectId,
      name: 'Alice', fields: {},
    });
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd' });

    const charImgId = new ObjectId();
    await fakeDb.collection('characters').updateOne(
      { _id: alice._id },
      { $set: { main_image_id: charImgId, images: [{ _id: charImgId }] } },
    );
    await Plots.pushBeatImage(projectId, beat._id.toString(), {
      _id: new ObjectId(),
      filename: 'x.png',
      content_type: 'image/png',
      size: 1,
      uploaded_at: new Date(),
    });

    const o = await buildOverview(projectId);
    expect(o.counts.characters_with_main_image).toBe(1);
    expect(o.counts.beats_with_main_image).toBe(1);
    expect(o.characters[0].has_main_image).toBe(true);
    expect(o.beats[0].has_main_image).toBe(true);
  });
});
