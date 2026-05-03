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
const {
  recordEntityTouch,
  resolveEntityLinks,
  appendEntityLinks,
  createTouchedEntities,
} = await import('../src/agent/entityLinks.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('recordEntityTouch', () => {
  it('records a beat for update_beat from input.identifier', () => {
    const t = createTouchedEntities();
    recordEntityTouch('update_beat', { identifier: '2' }, t);
    expect([...t.beats]).toEqual(['2']);
  });

  it('records a character for update_character from input.identifier', () => {
    const t = createTouchedEntities();
    recordEntityTouch('update_character', { identifier: 'Steve' }, t);
    expect([...t.characters]).toEqual(['Steve']);
  });

  it('flips notes flag for add_director_note', () => {
    const t = createTouchedEntities();
    recordEntityTouch('add_director_note', { text: 'remember the deadline' }, t);
    expect(t.notes).toBe(true);
  });

  it('ignores tools not in the registry', () => {
    const t = createTouchedEntities();
    recordEntityTouch('list_beats', {}, t);
    recordEntityTouch('delete_character', { identifier: 'Steve' }, t);
    recordEntityTouch('update_character_template', {}, t);
    recordEntityTouch('search_beats', { query: 'foo' }, t);
    expect([...t.beats]).toEqual([]);
    expect([...t.characters]).toEqual([]);
    expect(t.notes).toBe(false);
  });

  it('pushes :current: for get_current_beat with no input', () => {
    const t = createTouchedEntities();
    recordEntityTouch('get_current_beat', undefined, t);
    expect([...t.beats]).toEqual([':current:']);
  });

  it('pushes :current: for append_to_beat_body with empty beat', () => {
    const t = createTouchedEntities();
    recordEntityTouch('append_to_beat_body', { beat: '   ' }, t);
    expect([...t.beats]).toEqual([':current:']);
  });

  it('pushes :current: for link_character_to_beat when beat is omitted', () => {
    const t = createTouchedEntities();
    recordEntityTouch('link_character_to_beat', { character: 'Steve' }, t);
    expect([...t.beats]).toEqual([':current:']);
  });

  it('walks input.updates[].character for bulk_update_character_field and dedups', () => {
    const t = createTouchedEntities();
    recordEntityTouch(
      'bulk_update_character_field',
      {
        field_name: 'background',
        updates: [
          { character: 'Alice', value: 'a' },
          { character: 'Bob', value: 'b' },
          { character: 'Alice', value: 'a2' },
          { character: '   ', value: 'skip' },
        ],
      },
      t,
    );
    expect([...t.characters]).toEqual(['Alice', 'Bob']);
  });

  it('dedups identical refs across multiple calls', () => {
    const t = createTouchedEntities();
    recordEntityTouch('update_beat', { identifier: '2' }, t);
    recordEntityTouch('update_beat', { identifier: '2' }, t);
    recordEntityTouch('set_beat_body', { beat: '2' }, t);
    expect([...t.beats]).toEqual(['2']);
  });

  it('handles undefined or non-object input gracefully', () => {
    const t = createTouchedEntities();
    recordEntityTouch('update_beat', undefined, t);
    recordEntityTouch('update_beat', null, t);
    recordEntityTouch('update_beat', 'nope', t);
    expect([...t.beats]).toEqual([]);
  });
});

describe('resolveEntityLinks', () => {
  it('resolves :current: via plot.current_beat_id to the matching /beat/<order>', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'Opening scene' });
    await Plots.createBeat({ name: 'Inciting', desc: 'Inciting incident' });
    await Plots.setCurrentBeat(a.order); // sets current to beat 1
    const t = createTouchedEntities();
    t.beats.add(':current:');
    const urls = await resolveEntityLinks(t);
    expect(urls).toEqual(['http://localhost:3000/beat/1']);
  });

  it('resolves a beat by order', async () => {
    await Plots.createBeat({ name: 'Open', desc: 'A' });
    await Plots.createBeat({ name: 'Mid', desc: 'B' });
    const t = createTouchedEntities();
    t.beats.add('2');
    const urls = await resolveEntityLinks(t);
    expect(urls).toEqual(['http://localhost:3000/beat/2']);
  });

  it('resolves a character by name', async () => {
    await Characters.createCharacter({
      name: 'Steve',
      plays_self: true,
      hollywood_actor: null,
      own_voice: true,
    });
    const t = createTouchedEntities();
    t.characters.add('Steve');
    const urls = await resolveEntityLinks(t);
    expect(urls).toEqual(['http://localhost:3000/character/Steve']);
  });

  it('skips refs that no longer resolve without throwing', async () => {
    await Plots.createBeat({ name: 'Open', desc: 'A' });
    const t = createTouchedEntities();
    t.beats.add('99'); // no such beat
    t.characters.add('Ghost'); // no such character
    const urls = await resolveEntityLinks(t);
    expect(urls).toEqual([]);
  });

  it('returns exactly one /notes URL even when many note tools touched', async () => {
    const t = createTouchedEntities();
    t.notes = true;
    const urls = await resolveEntityLinks(t);
    expect(urls).toEqual(['http://localhost:3000/notes']);
  });

  it('orders output: notes first, then beats, then characters', async () => {
    await Plots.createBeat({ name: 'Open', desc: 'A' });
    await Characters.createCharacter({
      name: 'Steve',
      plays_self: true,
      hollywood_actor: null,
      own_voice: true,
    });
    const t = createTouchedEntities();
    t.characters.add('Steve');
    t.beats.add('1');
    t.notes = true;
    const urls = await resolveEntityLinks(t);
    expect(urls).toEqual([
      'http://localhost:3000/notes',
      'http://localhost:3000/beat/1',
      'http://localhost:3000/character/Steve',
    ]);
  });

  it('caps at 10 URLs even when more entities are touched', async () => {
    for (let i = 0; i < 15; i++) {
      await Characters.createCharacter({
        name: `Person${i}`,
        plays_self: true,
        hollywood_actor: null,
        own_voice: true,
      });
    }
    const t = createTouchedEntities();
    for (let i = 0; i < 15; i++) t.characters.add(`Person${i}`);
    const urls = await resolveEntityLinks(t);
    expect(urls).toHaveLength(10);
  });

  it('dedups URLs that resolve to the same beat from different identifiers', async () => {
    const a = await Plots.createBeat({ name: 'Open', desc: 'A' });
    const t = createTouchedEntities();
    t.beats.add('1'); // by order
    t.beats.add(a._id.toString()); // by _id
    t.beats.add('Open'); // by name
    const urls = await resolveEntityLinks(t);
    expect(urls).toEqual(['http://localhost:3000/beat/1']);
  });

  it('returns empty array for a fresh accumulator', async () => {
    const urls = await resolveEntityLinks(createTouchedEntities());
    expect(urls).toEqual([]);
  });
});

describe('appendEntityLinks', () => {
  it('returns text unchanged when urls is empty', () => {
    expect(appendEntityLinks('hello', [])).toBe('hello');
    expect(appendEntityLinks('hello', null)).toBe('hello');
    expect(appendEntityLinks('hello', undefined)).toBe('hello');
  });

  it('appends a single URL with the Edit in browser prefix', () => {
    expect(appendEntityLinks('Updated beat 2.', ['http://x/beat/2'])).toBe(
      'Updated beat 2.\n\nEdit in browser: http://x/beat/2',
    );
  });

  it('appends a bulleted list for 2+ URLs', () => {
    expect(
      appendEntityLinks('Done.', ['http://x/notes', 'http://x/character/Alice']),
    ).toBe('Done.\n\nEdit in browser:\n- http://x/notes\n- http://x/character/Alice');
  });

  it('skips a URL already present in text (withSpaLink dedup case)', () => {
    const text = 'Updated.\nEdit in browser: http://x/beat/2';
    expect(appendEntityLinks(text, ['http://x/beat/2'])).toBe(text);
  });

  it('partially dedups — keeps URLs not already in text', () => {
    const text = 'Updated.\nEdit in browser: http://x/beat/2';
    const out = appendEntityLinks(text, ['http://x/beat/2', 'http://x/notes']);
    expect(out).toBe(`${text}\n\nEdit in browser: http://x/notes`);
  });

  it('right-trims trailing whitespace from text before appending', () => {
    expect(appendEntityLinks('hello\n\n  ', ['http://x/y'])).toBe(
      'hello\n\nEdit in browser: http://x/y',
    );
  });

  it('handles null/undefined text', () => {
    expect(appendEntityLinks(null, ['http://x/y'])).toBe(
      '\n\nEdit in browser: http://x/y',
    );
    expect(appendEntityLinks(undefined, ['http://x/y'])).toBe(
      '\n\nEdit in browser: http://x/y',
    );
  });
});
