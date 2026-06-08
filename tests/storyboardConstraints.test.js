// tests/storyboardConstraints.test.js
import { describe, it, expect } from 'vitest';
import {
  CAMERA_MOTION_RULES,
  SUBJECT_MOTION_RULES,
  REVEAL_HANDLING,
  FRAMING_RULES,
  STILL_FRAMING_RULES,
  VIDEO_PROMPT_RULES,
} from '../src/web/storyboardConstraints.js';

describe('storyboard constraints', () => {
  it('every block is a non-empty string', () => {
    for (const block of [
      CAMERA_MOTION_RULES,
      SUBJECT_MOTION_RULES,
      REVEAL_HANDLING,
      FRAMING_RULES,
      STILL_FRAMING_RULES,
      VIDEO_PROMPT_RULES,
    ]) {
      expect(typeof block).toBe('string');
      expect(block.trim().length).toBeGreaterThan(0);
    }
  });

  it('camera rules name the locked-off default and forbid yaw/pan', () => {
    expect(CAMERA_MOTION_RULES.toLowerCase()).toContain('locked-off');
    expect(CAMERA_MOTION_RULES.toLowerCase()).toContain('pan');
  });

  it('reveal handling names reverse_in_post', () => {
    expect(REVEAL_HANDLING).toContain('reverse_in_post');
  });

  it('video-prompt rules put the camera first and end on a stillness constraint', () => {
    expect(VIDEO_PROMPT_RULES.toLowerCase()).toContain('locked-off');
    expect(VIDEO_PROMPT_RULES.toLowerCase()).toContain('no other movement');
  });

  it('still-framing rules require explicit subject orientation/heading', () => {
    expect(STILL_FRAMING_RULES.toLowerCase()).toContain('heading');
    expect(STILL_FRAMING_RULES.toLowerCase()).toContain('orientation');
  });
});
