import { describe, it, expect } from 'vitest';
import { IMAGE_MODEL_INFO } from '../src/web/imageModelInfo.js';
import { ALLOWED_IMAGE_MODELS } from '../src/web/imageReplaceDispatch.js';

// The SPA's model picker is the live fal catalog (ImageModelSelect), so there
// is no frontend list to mirror anymore. The invariant that remains: the
// tuned-model info registry must cover exactly the dispatcher's allowlist.
describe('image model registry parity', () => {
  it('info registry ids exactly match the dispatcher allowlist', () => {
    expect(Object.keys(IMAGE_MODEL_INFO).sort()).toEqual([...ALLOWED_IMAGE_MODELS].sort());
  });
});
