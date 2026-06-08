// tests/storyboardConstraints.test.js
import { describe, it, expect } from 'vitest';
import {
  CAMERA_MOTION_RULES,
  SUBJECT_MOTION_RULES,
  REVEAL_HANDLING,
  FRAMING_RULES,
  STILL_FRAMING_RULES,
} from '../src/web/storyboardConstraints.js';

describe('storyboard constraints', () => {
  it('every block is a non-empty string', () => {
    for (const block of [
      CAMERA_MOTION_RULES,
      SUBJECT_MOTION_RULES,
      REVEAL_HANDLING,
      FRAMING_RULES,
      STILL_FRAMING_RULES,
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
});
