// Ordering rules for the image-model picker: price ascending by default,
// descending on request, name as a third option — and unpriced models always
// last, whichever price direction is chosen.

import { describe, it, expect } from 'vitest';

const {
  sortImageModels,
  isImageModelSort,
  DEFAULT_IMAGE_MODEL_SORT,
  IMAGE_MODEL_SORTS,
} = await import('../web/src/widgets/imageModelSort.js');

function model(display_name, sort_usd) {
  return { id: display_name, display_name, price: { sort_usd, display: sort_usd ? `$${sort_usd}` : null } };
}

const CATALOG = [
  model('Zebra', 0.04),
  model('Alpha', 0.15),
  model('Mystery', null),
  model('Bravo', 0.011),
  model('Enigma', null),
];

const names = (rows) => rows.map((m) => m.display_name);

describe('sortImageModels', () => {
  it('defaults to cheapest first', () => {
    expect(names(sortImageModels(CATALOG))).toEqual([
      'Bravo', 'Zebra', 'Alpha', 'Enigma', 'Mystery',
    ]);
  });

  it('puts the most expensive first when asked', () => {
    expect(names(sortImageModels(CATALOG, 'price-desc'))).toEqual([
      'Alpha', 'Zebra', 'Bravo', 'Enigma', 'Mystery',
    ]);
  });

  it('keeps unpriced models at the bottom in BOTH price directions', () => {
    for (const sort of ['price-asc', 'price-desc']) {
      const rows = sortImageModels(CATALOG, sort);
      expect(names(rows).slice(-2)).toEqual(['Enigma', 'Mystery']);
    }
  });

  it('sorts by name when asked, mixing priced and unpriced', () => {
    expect(names(sortImageModels(CATALOG, 'name'))).toEqual([
      'Alpha', 'Bravo', 'Enigma', 'Mystery', 'Zebra',
    ]);
  });

  it('breaks price ties by name so the order never shuffles', () => {
    const tied = [model('Delta', 0.04), model('Charlie', 0.04)];
    expect(names(sortImageModels(tied))).toEqual(['Charlie', 'Delta']);
    expect(names(sortImageModels(tied, 'price-desc'))).toEqual(['Charlie', 'Delta']);
  });

  it('does not mutate the array it was given', () => {
    const input = [...CATALOG];
    sortImageModels(input, 'price-desc');
    expect(names(input)).toEqual(names(CATALOG));
  });

  it('treats a missing price object as unpriced rather than throwing', () => {
    const rows = sortImageModels([{ display_name: 'Bare' }, model('Cheap', 0.01)]);
    expect(names(rows)).toEqual(['Cheap', 'Bare']);
  });

  it('falls back to the default ordering for an unknown sort key', () => {
    expect(names(sortImageModels(CATALOG, 'nonsense'))).toEqual(
      names(sortImageModels(CATALOG, DEFAULT_IMAGE_MODEL_SORT)),
    );
  });
});

describe('sort options', () => {
  it('offers exactly the three documented orderings', () => {
    expect(IMAGE_MODEL_SORTS.map((s) => s.key)).toEqual(['price-asc', 'price-desc', 'name']);
  });

  it('defaults to cheapest first', () => {
    expect(DEFAULT_IMAGE_MODEL_SORT).toBe('price-asc');
  });

  it('validates stored sort keys', () => {
    expect(isImageModelSort('price-desc')).toBe(true);
    expect(isImageModelSort('by-vibes')).toBe(false);
  });
});
