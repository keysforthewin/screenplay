// Is a cut the same camera setup as the one before it (src/web/cutCoverage.js)?
import { describe, it, expect } from 'vitest';
import { findRepeatedSetups, sameSetup, sideSimilarity } from '../src/web/cutCoverage.js';
import * as Twin from '../web/src/widgets/cutCoverage.js';

const cut = (over = {}) => ({
  camera: { size: 'medium_close_up', angle: 'eye_level', side: 'from the aisle, looking at the boy in the third seat', ...(over.camera || {}) },
  in_frame: [{ character: 'Danny' }],
  action_by: 'Danny',
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'camera')),
});

describe('sameSetup', () => {
  it('the same subject, size, angle and side is the same setup, whatever the move or the wording', () => {
    expect(sameSetup(cut(), cut())).toBe(true);
    expect(sameSetup(cut(), cut({ camera: { side: 'From the aisle, looking toward the boy in the third seat.', movement: 'push_in' } }))).toBe(true);
  });

  it('a different size, angle, side or subject is another setup', () => {
    expect(sameSetup(cut(), cut({ camera: { size: 'wide' } }))).toBe(false);
    expect(sameSetup(cut(), cut({ camera: { angle: 'low' } }))).toBe(false);
    expect(sameSetup(cut(), cut({ camera: { side: 'from behind his seat, looking over his shoulder at the screen' } }))).toBe(false);
    expect(sameSetup(cut(), cut({ action_by: 'Mum', in_frame: [{ character: 'Mum' }] }))).toBe(false);
    expect(sameSetup(cut(), { camera: {} })).toBe(false);
  });

  it('sideSimilarity ignores filler words', () => {
    expect(sideSimilarity('from the counter end', 'at the counter end')).toBe(1);
    expect(sideSimilarity('', '')).toBe(1);
    expect(sideSimilarity('from the counter end', '')).toBe(0);
  });
});

describe('findRepeatedSetups', () => {
  it('reports consecutive repeats, not a return to a setup, and not a marked continuation', () => {
    const reverse = cut({ camera: { size: 'wide', side: 'from behind the row, looking at the screen' }, in_frame: [], action_by: '' });
    expect(findRepeatedSetups([cut(), cut(), reverse, cut()])).toEqual([{ index: 1 }]);
    expect(findRepeatedSetups([cut(), cut({ continues_previous: true })])).toEqual([]);
    expect(findRepeatedSetups([])).toEqual([]);
  });

  it('the SPA twin agrees', () => {
    expect(Twin.sameSetup(cut(), cut())).toBe(true);
    expect(Twin.findRepeatedSetups([cut(), cut()])).toEqual([{ index: 1 }]);
  });
});
