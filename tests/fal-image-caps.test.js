import { describe, it, expect } from 'vitest';
import {
  FLUX_2_PRO_EDIT_MAX_INPUTS,
  NANO_BANANA_PRO_EDIT_MAX_INPUTS,
  GEMINI_25_FLASH_EDIT_MAX_INPUTS,
  NANO_BANANA_2_EDIT_MAX_INPUTS,
  FLUX_2_KLEIN_EDIT_MAX_INPUTS,
} from '../src/fal/imageClient.js';

describe('fal reference caps', () => {
  it('exports the documented per-endpoint maxima', () => {
    expect(FLUX_2_PRO_EDIT_MAX_INPUTS).toBe(9);
    expect(NANO_BANANA_PRO_EDIT_MAX_INPUTS).toBe(14);
    expect(GEMINI_25_FLASH_EDIT_MAX_INPUTS).toBe(10);
    expect(NANO_BANANA_2_EDIT_MAX_INPUTS).toBe(10);
    expect(FLUX_2_KLEIN_EDIT_MAX_INPUTS).toBe(4);
  });
});
