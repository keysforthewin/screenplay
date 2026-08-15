import { describe, expect, it } from 'vitest';
import { computeOwners } from '../web/src/widgets/sheetReferenceOwners.js';

// TOC fixture: three beats; Kitchen in beats 1+2, Alley in beat 2, Rooftop in
// beat 3 only. Steve in beats 1+2, Dana in beat 2, Hermit in beat 3 only.
const toc = {
  beats: [
    { _id: 'b1', order: 1 },
    { _id: 'b2', order: 2 },
    { _id: 'b3', order: 3 },
  ],
  sets: [
    { _id: 's1', plain_name: 'Kitchen', beats: [{ order: 1 }, { order: 2 }] },
    { _id: 's2', plain_name: 'Alley', beats: [{ order: 2 }] },
    { _id: 's3', plain_name: 'Rooftop', beats: [{ order: 3 }] },
  ],
  characters: [
    { _id: 'c1', plain_name: 'Steve', beats: [{ order: 1 }, { order: 2 }] },
    { _id: 'c2', plain_name: 'Dana', beats: [{ order: 2 }] },
    { _id: 'c3', plain_name: 'Hermit', beats: [{ order: 3 }] },
  ],
};

describe('computeOwners', () => {
  it('set host: this set first, then sets staged by the checked beats', () => {
    const owners = computeOwners({
      hostType: 'set',
      hostId: 's1',
      hostLabel: 'Kitchen',
      beatIds: ['b1', 'b2'],
      toc,
    });
    expect(owners.map((o) => o.id)).toEqual(['s1', 's2']);
    expect(owners[0]).toMatchObject({ isHost: true, label: 'This set (Kitchen)' });
    expect(owners[1]).toMatchObject({ isHost: false, label: 'Alley' });
  });

  it('set host: sets outside the checked beats get no tab', () => {
    const owners = computeOwners({
      hostType: 'set',
      hostId: 's1',
      beatIds: ['b1'], // beat 1 stages only Kitchen
      toc,
    });
    expect(owners.map((o) => o.id)).toEqual(['s1']);
  });

  it('set host: no checked beats leaves just the host tab', () => {
    const owners = computeOwners({ hostType: 'set', hostId: 's1', beatIds: [], toc });
    expect(owners.map((o) => o.id)).toEqual(['s1']);
  });

  it('set host: other tabs sort by earliest shared beat order', () => {
    const wide = {
      beats: [
        { _id: 'b1', order: 1 },
        { _id: 'b2', order: 2 },
      ],
      sets: [
        { _id: 'host', plain_name: 'Host', beats: [{ order: 1 }] },
        { _id: 'late', plain_name: 'Late', beats: [{ order: 2 }] },
        { _id: 'early', plain_name: 'Early', beats: [{ order: 1 }] },
      ],
      characters: [],
    };
    const owners = computeOwners({
      hostType: 'set',
      hostId: 'host',
      beatIds: ['b1', 'b2'],
      toc: wide,
    });
    expect(owners.map((o) => o.id)).toEqual(['host', 'early', 'late']);
  });

  it('character host: tabs for characters sharing at least one beat', () => {
    const owners = computeOwners({ hostType: 'character', hostId: 'c1', toc });
    expect(owners.map((o) => o.id)).toEqual(['c1', 'c2']); // Hermit (beat 3 only) excluded
    expect(owners[0].label).toBe('This character (Steve)');
  });

  it('character host: a character in no beats gets only its own tab', () => {
    const loner = {
      ...toc,
      characters: [...toc.characters, { _id: 'c4', plain_name: 'Ghost', beats: [] }],
    };
    const owners = computeOwners({ hostType: 'character', hostId: 'c4', toc: loner });
    expect(owners.map((o) => o.id)).toEqual(['c4']);
  });

  it('character host missing from the toc falls back to hostLabel', () => {
    const owners = computeOwners({
      hostType: 'character',
      hostId: 'unknown',
      hostLabel: 'Newbie',
      toc,
    });
    expect(owners).toEqual([
      { id: 'unknown', label: 'This character (Newbie)', isHost: true },
    ]);
  });

  it('beat host (tune flow): tabs are the sets in that beat, no host tab', () => {
    const owners = computeOwners({ hostType: 'beat', hostId: 'b2', toc });
    expect(owners.map((o) => o.id)).toEqual(['s1', 's2']);
    expect(owners.every((o) => !o.isHost)).toBe(true);
  });

  it('beat host with no sets returns an empty list', () => {
    const owners = computeOwners({ hostType: 'beat', hostId: 'b3', toc: { ...toc, sets: [] } });
    expect(owners).toEqual([]);
  });

  it('tolerates a missing/empty toc', () => {
    expect(computeOwners({ hostType: 'set', hostId: 's1', hostLabel: 'Kitchen', beatIds: ['b1'], toc: null }))
      .toEqual([{ id: 's1', label: 'This set (Kitchen)', isHost: true }]);
    expect(computeOwners({ hostType: 'beat', hostId: 'b1', toc: {} })).toEqual([]);
  });
});
