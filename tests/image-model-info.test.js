import { describe, it, expect } from 'vitest';
import {
  IMAGE_MODEL_INFO,
  listImageModelInfo,
  maxReferenceImagesFor,
  DEFAULT_MAX_REFERENCE_IMAGES,
} from '../src/web/imageModelInfo.js';
import { FLUX_2_KLEIN_EDIT_MAX_INPUTS } from '../src/fal/imageClient.js';

const EXPECTED_IDS = [
  'nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai',
  'gemini-25-flash', 'nano-banana-2', 'flux-2-klein',
];

describe('imageModelInfo', () => {
  it('has one entry per supported model with full metadata', () => {
    const list = listImageModelInfo();
    expect(list.map((m) => m.id)).toEqual(EXPECTED_IDS);
    for (const m of list) {
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(0);
      expect(typeof m.maxReferenceImages).toBe('number');
      expect(m.maxReferenceImages).toBeGreaterThan(0);
      expect(typeof m.resolution).toBe('string');
      expect(Array.isArray(m.inputFormats)).toBe(true);
      expect(m.inputFormats.length).toBeGreaterThan(0);
      expect(typeof m.speed).toBe('string');
    }
  });

  it('sources the klein cap from the fal client (single source of truth)', () => {
    expect(IMAGE_MODEL_INFO['flux-2-klein'].maxReferenceImages).toBe(
      FLUX_2_KLEIN_EDIT_MAX_INPUTS,
    );
    expect(IMAGE_MODEL_INFO['flux-2-klein'].maxReferenceImages).toBe(4);
  });

  it('maxReferenceImagesFor falls back for unknown ids', () => {
    expect(maxReferenceImagesFor('nano-banana-pro')).toBe(14);
    expect(maxReferenceImagesFor('totally-unknown')).toBe(DEFAULT_MAX_REFERENCE_IMAGES);
    expect(DEFAULT_MAX_REFERENCE_IMAGES).toBe(6);
  });
});
