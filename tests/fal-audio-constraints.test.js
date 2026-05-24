// The per-endpoint audio constraints table that drives the submit-time trim
// and the Generate Video dialog notice.

import { describe, it, expect } from 'vitest';
import { getAudioConstraints, getMaxAudioSeconds } from '../src/fal/videoModels.js';

describe('getAudioConstraints', () => {
  it('returns the 15s MP3 cap for seedance reference-to-video endpoints', () => {
    expect(getAudioConstraints('bytedance/seedance-2.0/reference-to-video')).toEqual({
      format: 'mp3',
      maxAudioSeconds: 15,
    });
    expect(
      getAudioConstraints('bytedance/seedance-2.0/fast/reference-to-video'),
    ).toEqual({ format: 'mp3', maxAudioSeconds: 15 });
  });

  it('returns the resolution-keyed cap for omnihuman v1.5', () => {
    const c = getAudioConstraints('fal-ai/bytedance/omnihuman/v1.5');
    expect(c.format).toBe('mp3');
    expect(c.maxAudioSeconds).toBe(30); // conservative fallback (1080p)
    expect(c.maxAudioSecondsByResolution).toEqual({ '720p': 60, '1080p': 30 });
  });

  it('returns null for endpoints without a declared audio constraint', () => {
    expect(getAudioConstraints('bytedance/seedance-2.0/image-to-video')).toBeNull();
    expect(getAudioConstraints('fal-ai/kling-video/ai-avatar/v2/pro')).toBeNull();
    expect(getAudioConstraints('')).toBeNull();
    expect(getAudioConstraints(null)).toBeNull();
    expect(getAudioConstraints(undefined)).toBeNull();
  });
});

describe('getMaxAudioSeconds', () => {
  it('picks the per-resolution cap for omnihuman v1.5 when resolution is known', () => {
    expect(getMaxAudioSeconds('fal-ai/bytedance/omnihuman/v1.5', '720p')).toBe(60);
    expect(getMaxAudioSeconds('fal-ai/bytedance/omnihuman/v1.5', '1080p')).toBe(30);
    expect(getMaxAudioSeconds('fal-ai/bytedance/omnihuman/v1.5', '720P')).toBe(60); // case-insensitive
  });

  it('falls back to the flat cap when resolution is unknown or unmapped', () => {
    expect(getMaxAudioSeconds('fal-ai/bytedance/omnihuman/v1.5', null)).toBe(30);
    expect(getMaxAudioSeconds('fal-ai/bytedance/omnihuman/v1.5', '480p')).toBe(30);
    expect(getMaxAudioSeconds('fal-ai/bytedance/omnihuman/v1.5')).toBe(30);
  });

  it('returns the flat cap for endpoints without a per-resolution table', () => {
    expect(getMaxAudioSeconds('bytedance/seedance-2.0/reference-to-video', '1080p')).toBe(15);
  });

  it('returns null for endpoints without any audio constraint', () => {
    expect(getMaxAudioSeconds('fal-ai/kling-video/ai-avatar/v2/pro', '720p')).toBeNull();
    expect(getMaxAudioSeconds(null, '720p')).toBeNull();
  });
});
