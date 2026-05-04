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
    expect(out.beats).toEqual([{ _id: beats[0]._id, order: 1, name: 'Opening', plain_name: 'Opening' }]);
  });
});
