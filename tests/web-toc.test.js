import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
import { buildTocResponse } from '../src/web/toc.js';

function character(name) {
  return { _id: new ObjectId(), name };
}

function beat(order, name, characters = []) {
  return { _id: new ObjectId(), order, name, characters };
}

describe('buildTocResponse', () => {
  it('attaches the beats each character appears in, sorted by order', () => {
    const characters = [character('Alice'), character('Bob'), character('Carol')];
    const beats = [
      beat(2, 'Chase scene', ['Alice', 'Bob']),
      beat(1, 'Opening', ['Alice']),
      beat(3, 'Confession', ['Alice']),
    ];
    const out = buildTocResponse(characters, beats, 0);

    const alice = out.characters.find((c) => c.plain_name === 'Alice');
    expect(alice.beats).toEqual([
      { order: 1, plain_name: 'Opening' },
      { order: 2, plain_name: 'Chase scene' },
      { order: 3, plain_name: 'Confession' },
    ]);

    const bob = out.characters.find((c) => c.plain_name === 'Bob');
    expect(bob.beats).toEqual([{ order: 2, plain_name: 'Chase scene' }]);
  });

  it('returns an empty beats array for a character with no appearances', () => {
    const characters = [character('Alice'), character('Carol')];
    const beats = [beat(1, 'Opening', ['Alice'])];
    const out = buildTocResponse(characters, beats, 0);
    const carol = out.characters.find((c) => c.plain_name === 'Carol');
    expect(carol.beats).toEqual([]);
  });

  it('matches across markdown formatting on either side', () => {
    const characters = [character('**Steve**')];
    const beats = [beat(1, 'Opening', ['Steve']), beat(2, 'Climax', ['_Steve_'])];
    const out = buildTocResponse(characters, beats, 0);
    const steve = out.characters.find((c) => c.plain_name === 'Steve');
    expect(steve.beats.map((b) => b.order)).toEqual([1, 2]);
  });

  it('matches case-insensitively', () => {
    const characters = [character('alice')];
    const beats = [beat(1, 'Opening', ['ALICE'])];
    const out = buildTocResponse(characters, beats, 0);
    expect(out.characters[0].beats).toEqual([{ order: 1, plain_name: 'Opening' }]);
  });

  it('uses the beat plain_name (markdown stripped) for display', () => {
    const characters = [character('Alice')];
    const beats = [beat(1, '**Opening** scene', ['Alice'])];
    const out = buildTocResponse(characters, beats, 0);
    expect(out.characters[0].beats).toEqual([{ order: 1, plain_name: 'Opening scene' }]);
  });

  it('preserves the existing beats and notes_count fields on the response', () => {
    const characters = [character('Alice')];
    const beats = [beat(1, 'Opening', ['Alice'])];
    const out = buildTocResponse(characters, beats, 7);
    expect(out.notes_count).toBe(7);
    expect(out.beats).toEqual([
      {
        _id: beats[0]._id,
        order: 1,
        name: 'Opening',
        plain_name: 'Opening',
        body_empty: true,
        storyboard_count: 0,
        dialog_count: 0,
        search_text: 'opening\nalice',
        dialog_search_text: '',
        storyboard_search_text: '',
      },
    ]);
  });

  it('flags beats with empty body and includes storyboard counts', () => {
    const beats = [
      { ...beat(1, 'Opening', []), body: 'has content' },
      { ...beat(2, 'Closing', []), body: '' },
      beat(3, 'Climax'),
    ];
    const counts = new Map();
    counts.set(beats[0]._id.toString(), 3);
    counts.set(beats[2]._id.toString(), 1);
    const out = buildTocResponse([], beats, 0, counts);
    expect(out.beats[0].body_empty).toBe(false);
    expect(out.beats[0].storyboard_count).toBe(3);
    expect(out.beats[1].body_empty).toBe(true);
    expect(out.beats[1].storyboard_count).toBe(0);
    expect(out.beats[2].body_empty).toBe(true);
    expect(out.beats[2].storyboard_count).toBe(1);
  });

  it('threads dialog_count through alongside storyboard_count', () => {
    const beats = [beat(1, 'Opening', []), beat(2, 'Confrontation', [])];
    const sbCounts = new Map();
    sbCounts.set(beats[0]._id.toString(), 2);
    const dCounts = new Map();
    dCounts.set(beats[1]._id.toString(), 5);
    const out = buildTocResponse([], beats, 0, sbCounts, dCounts);
    expect(out.beats[0].storyboard_count).toBe(2);
    expect(out.beats[0].dialog_count).toBe(0);
    expect(out.beats[1].storyboard_count).toBe(0);
    expect(out.beats[1].dialog_count).toBe(5);
  });

  it('builds search_text on beats from name + body + characters list', () => {
    const beats = [
      {
        ...beat(1, '**Opening** scene', ['Alice', 'Bob']),
        body: 'Alice pushes the door open. *The wind howls.*',
      },
    ];
    const out = buildTocResponse([], beats, 0);
    const s = out.beats[0].search_text;
    expect(s).toContain('opening scene');
    expect(s).toContain('alice pushes the door open');
    expect(s).toContain('the wind howls');
    expect(s).toContain('alice');
    expect(s).toContain('bob');
  });

  it('aggregates dialog text per beat into dialog_search_text', () => {
    const beats = [beat(1, 'Diner', []), beat(2, 'Park', [])];
    const allDialogs = [
      { beat_id: beats[0]._id, body: "Don't go in there.", character: 'Pauly' },
      { beat_id: beats[0]._id, body: 'Why not?', character: 'Lisa' },
      { beat_id: beats[1]._id, body: 'Run!', character: 'Sam' },
    ];
    const out = buildTocResponse([], beats, 0, null, null, {
      allDialogs,
    });
    const diner = out.beats.find((b) => b.order === 1);
    const park = out.beats.find((b) => b.order === 2);
    expect(diner.dialog_search_text).toContain("don't go in there");
    expect(diner.dialog_search_text).toContain('pauly');
    expect(diner.dialog_search_text).toContain('why not');
    expect(diner.dialog_search_text).not.toContain('run!');
    expect(park.dialog_search_text).toContain('run!');
    expect(park.dialog_search_text).toContain('sam');
  });

  it('aggregates storyboard scene prompts per beat into storyboard_search_text', () => {
    const beats = [beat(1, 'Chase', []), beat(2, 'Quiet', [])];
    const allStoryboards = [
      { beat_id: beats[0]._id, text_prompt: 'wide shot of the alley at dusk' },
      { beat_id: beats[0]._id, text_prompt: 'close on running feet' },
      { beat_id: beats[1]._id, text_prompt: 'still life of teacup' },
    ];
    const out = buildTocResponse([], beats, 0, null, null, {
      allStoryboards,
    });
    const chase = out.beats.find((b) => b.order === 1);
    const quiet = out.beats.find((b) => b.order === 2);
    expect(chase.storyboard_search_text).toContain('alley at dusk');
    expect(chase.storyboard_search_text).toContain('running feet');
    expect(chase.storyboard_search_text).not.toContain('teacup');
    expect(quiet.storyboard_search_text).toContain('teacup');
  });

  it('builds character search_text from name + hollywood_actor + fields values', () => {
    const characters = [
      {
        _id: new ObjectId(),
        name: '**Pauly**',
        hollywood_actor: 'Joe Pesci',
        fields: {
          description: 'Short-tempered diner owner.',
          backstory: 'Used to box in Jersey.',
          eye_color: 'brown',
          custom_obj: { not: 'a string' },
        },
      },
    ];
    const out = buildTocResponse(characters, [], 0);
    const s = out.characters[0].search_text;
    expect(s).toContain('pauly');
    expect(s).toContain('joe pesci');
    expect(s).toContain('short-tempered diner owner');
    expect(s).toContain('used to box in jersey');
    expect(s).toContain('brown');
  });

  it('projects main_image_id on each character (or null when absent)', () => {
    const portraitId = new ObjectId();
    const characters = [
      { _id: new ObjectId(), name: 'Alice', main_image_id: portraitId },
      { _id: new ObjectId(), name: 'Bob' },
    ];
    const out = buildTocResponse(characters, [], 0);
    const alice = out.characters.find((c) => c.plain_name === 'Alice');
    const bob = out.characters.find((c) => c.plain_name === 'Bob');
    expect(alice.main_image_id).toBe(portraitId);
    expect(bob.main_image_id).toBe(null);
  });
});
