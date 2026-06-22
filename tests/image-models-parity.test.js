import { describe, it, expect } from 'vitest';
import { IMAGE_MODEL_INFO } from '../src/web/imageModelInfo.js';

// Mirror of web/src/widgets/imageModels.js IMAGE_MODELS ids. If you add a model
// in one place you must add it in the other; this test fails on drift.
const FRONTEND_MODEL_IDS = [
  'nano-banana-pro', 'flux-2-pro', 'flux-pro-kontext', 'openai',
  'gemini-25-flash', 'nano-banana-2', 'flux-2-klein',
];

describe('image model registry parity', () => {
  it('backend registry ids exactly match the frontend picker ids', () => {
    expect(Object.keys(IMAGE_MODEL_INFO).sort()).toEqual([...FRONTEND_MODEL_IDS].sort());
  });
});
