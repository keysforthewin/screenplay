// tests/sceneBible.test.js
import { describe, it, expect } from 'vitest';
import {
  SCENE_BIBLE_FIELDS,
  normalizeSceneBible,
  isEmptySceneBible,
  renderSceneBibleBlock,
} from '../src/mongo/sceneBible.js';

describe('normalizeSceneBible', () => {
  it('returns an all-empty-string object for null/garbage input', () => {
    const b = normalizeSceneBible(null);
    for (const f of SCENE_BIBLE_FIELDS) expect(b[f]).toBe('');
    expect(b.updated_at).toBeInstanceOf(Date);
  });

  it('keeps known string fields and drops unknown keys', () => {
    const b = normalizeSceneBible({ location: 'Diner', bogus: 'x', mood: 'tense' });
    expect(b.location).toBe('Diner');
    expect(b.mood).toBe('tense');
    expect(b).not.toHaveProperty('bogus');
  });

  it('coerces non-string field values to empty string', () => {
    const b = normalizeSceneBible({ location: 42, palette: ['a', 'b'] });
    expect(b.location).toBe('');
    expect(b.palette).toBe('');
  });

  it('trims whitespace', () => {
    expect(normalizeSceneBible({ location: '  Diner  ' }).location).toBe('Diner');
  });
});

describe('isEmptySceneBible', () => {
  it('is true for null and for an all-empty bible', () => {
    expect(isEmptySceneBible(null)).toBe(true);
    expect(isEmptySceneBible(normalizeSceneBible({}))).toBe(true);
  });
  it('is false when any field has content', () => {
    expect(isEmptySceneBible(normalizeSceneBible({ mood: 'tense' }))).toBe(false);
  });
});

describe('renderSceneBibleBlock', () => {
  it('returns null when the bible is empty', () => {
    expect(renderSceneBibleBlock(null)).toBeNull();
    expect(renderSceneBibleBlock(normalizeSceneBible({}))).toBeNull();
  });
  it('renders only the populated fields, each on its own labeled line', () => {
    const block = renderSceneBibleBlock(
      normalizeSceneBible({ location: 'Corner diner', mood: 'tense' }),
    );
    expect(block).toContain('Location: Corner diner');
    expect(block).toContain('Mood: tense');
    expect(block).not.toContain('Palette:');
  });
});
