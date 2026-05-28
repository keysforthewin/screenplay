import { describe, expect, it } from 'vitest';
import { beatNeighbors } from '../web/src/widgets/BeatPager.jsx';

const beats = [
  { _id: 'a1', order: 1, plain_name: 'Open' },
  { _id: 'b2', order: 2, plain_name: 'Heist' },
  { _id: 'c3', order: 5, plain_name: 'Escape' }, // non-contiguous order
  { _id: 'd4', order: 9, plain_name: '' },
];

describe('beatNeighbors', () => {
  it('returns null prev at the first beat', () => {
    const { prev, next } = beatNeighbors(beats, 'a1');
    expect(prev).toBeNull();
    expect(next?._id).toBe('b2');
  });

  it('returns null next at the last beat', () => {
    const { prev, next } = beatNeighbors(beats, 'd4');
    expect(prev?._id).toBe('c3');
    expect(next).toBeNull();
  });

  it('returns both neighbors for a middle beat (non-contiguous orders ok)', () => {
    const { prev, next } = beatNeighbors(beats, 'c3');
    expect(prev?.order).toBe(2);
    expect(next?.order).toBe(9);
  });

  it('matches ObjectId-like values by string', () => {
    const oid = { toString: () => 'b2' };
    const { prev, next } = beatNeighbors(beats, oid);
    expect(prev?._id).toBe('a1');
    expect(next?._id).toBe('c3');
  });

  it('returns nulls when the id is not found', () => {
    expect(beatNeighbors(beats, 'zzz')).toEqual({ prev: null, next: null });
  });

  it('returns nulls for empty or missing input', () => {
    expect(beatNeighbors([], 'a1')).toEqual({ prev: null, next: null });
    expect(beatNeighbors(null, 'a1')).toEqual({ prev: null, next: null });
    expect(beatNeighbors(beats, null)).toEqual({ prev: null, next: null });
  });
});
