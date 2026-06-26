import { describe, it, expect } from 'vitest';
import {
  announceFieldsForDesc,
  diffCast,
  joinNames,
  buildWritingPayload,
  buildCharacterPayload,
  buildCastPayload,
} from '../src/web/editAnnounce.js';

describe('announceFieldsForDesc', () => {
  it('returns name/body/desc for a beat, excluding scene_bible and captions', () => {
    const desc = {
      type: 'beat',
      fields: ['name', 'body', 'desc', 'scene_bible.location', 'image:aaa:name'],
    };
    expect(announceFieldsForDesc(desc).sort()).toEqual(['body', 'desc', 'name']);
  });

  it('returns text fields for a character, excluding image/attachment captions', () => {
    const desc = {
      type: 'character',
      fields: ['name', 'hollywood_actor', 'fields.bio', 'image:aaa:name', 'attachment:bbb:description'],
    };
    expect(announceFieldsForDesc(desc).sort()).toEqual(['fields.bio', 'hollywood_actor', 'name']);
  });

  it('returns [] for other room types', () => {
    expect(announceFieldsForDesc({ type: 'storyboards', fields: ['item:x:summary'] })).toEqual([]);
  });
});

describe('diffCast', () => {
  it('detects adds and removes case-insensitively', () => {
    expect(diffCast(['Steve', 'Mary'], ['mary', 'Bob'])).toEqual({ added: ['Bob'], removed: ['Steve'] });
  });
  it('returns empty arrays when unchanged', () => {
    expect(diffCast(['A'], ['a'])).toEqual({ added: [], removed: [] });
  });
});

describe('joinNames', () => {
  it('formats one, two, and three names', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B, and C');
  });
});

describe('message payload builders', () => {
  const beat = { _id: 'b1', order: 22, name: '**The Heist**' };
  it('writing payload', () => {
    const p = buildWritingPayload({ who: 'Steve', beat, projectTitle: 'Film' });
    expect(p.username).toBe('Steve');
    expect(p.verb).toBe('edited the writing in');
    expect(p.entityLabel).toBe('Beat 22: The Heist');
  });
  it('character payload', () => {
    const p = buildCharacterPayload({ who: 'Steve', character: { name: 'Mary' }, projectTitle: 'Film' });
    expect(p.verb).toBe('edited');
    expect(p.entityLabel).toBe('Character: Mary');
  });
  it('cast payload: only adds', () => {
    const p = buildCastPayload({ who: 'Steve', beat, projectTitle: 'Film', added: ['Mary'], removed: [] });
    expect(p.verb).toBe('added Mary to');
    expect(p.entityLabel).toBe('Beat 22: The Heist');
  });
  it('cast payload: only removes', () => {
    const p = buildCastPayload({ who: 'Steve', beat, projectTitle: 'Film', added: [], removed: ['Bob'] });
    expect(p.verb).toBe('removed Bob from');
  });
  it('cast payload: mixed uses generic verb + detail prompt', () => {
    const p = buildCastPayload({ who: 'Steve', beat, projectTitle: 'Film', added: ['Mary'], removed: ['Bob'] });
    expect(p.verb).toBe('changed the cast of');
    expect(p.prompt).toContain('Added Mary');
    expect(p.prompt).toContain('removed Bob');
  });
});
