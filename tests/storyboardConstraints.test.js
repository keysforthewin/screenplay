// tests/storyboardConstraints.test.js
import { describe, it, expect } from 'vitest';
import {
  CAMERA_MOTION_RULES,
  SUBJECT_MOTION_RULES,
  REVEAL_HANDLING,
  FRAMING_RULES,
  STILL_FRAMING_RULES,
  VIDEO_PROMPT_RULES,
  OCCUPANT_PLACEHOLDER_RULES,
  CAMERA_COHERENCE_RULES,
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
      OCCUPANT_PLACEHOLDER_RULES,
      CAMERA_COHERENCE_RULES,
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

  it('still-framing rules keep a vehicle in its lane, not the road center', () => {
    expect(STILL_FRAMING_RULES.toLowerCase()).toContain('travel lane');
    // The old "road's center axis" wording pushed vehicles onto the centerline.
    expect(STILL_FRAMING_RULES.toLowerCase()).not.toContain('center axis');
  });

  it('still-framing rules require naming the beat sub-location / seat (back-seat fix)', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    expect(t).toContain('sub-location');
    expect(t).toContain('back seat');
  });

  it('still-framing rules demand sub-location even on close-ups, with an anchoring cue against the wrong default', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    // Required in every still, including tight close-ups where the seat seems invisible.
    expect(t).toContain('every still');
    expect(t).toContain('close-up');
    // Positive anchoring cue, and the concrete wrong-default it must defeat.
    expect(t).toContain('anchoring');
    expect(t).toContain('headrest');
    expect(t).toContain('front passenger');
  });

  it('occupant placeholder rules cover interiors framed from outside', () => {
    const t = OCCUPANT_PLACEHOLDER_RULES.toLowerCase();
    expect(t).toContain('placeholder');
    expect(t).toContain('through the glass');
    expect(t).toContain('number');
  });

  it('camera-coherence rules tie the eyeline to what is visible (no two-vantage frames)', () => {
    const t = CAMERA_COHERENCE_RULES.toLowerCase();
    expect(t).toContain('eyeline');
    expect(t).toContain('face');
    expect(t).toContain('back');
    expect(t).toContain('two separate shots');
  });

  it('still-framing rules treat the start frame as the initial state at t=0', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    expect(t).toContain('initial state');
    expect(t).toContain('first frame');
  });

  it('still-framing rules withhold mid-clip non-solid effects from the still (shooting-star fix)', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    expect(t).toContain('non-solid');
    expect(t).toContain('shooting star');
    // The withheld effect belongs in the video_prompt, not the opening still.
    expect(t).toContain('video_prompt');
  });

  it('subject-motion rules scope the "already in the start frame" ban to solids and exempt non-solid effects', () => {
    const t = SUBJECT_MOTION_RULES.toLowerCase();
    expect(t).toContain('solid');
    // Non-solid effects are the sanctioned exception that may appear mid-clip.
    expect(t).toContain('non-solid');
    expect(t).toContain('exception');
  });

  it('video-prompt hero temporal change may be a non-solid effect absent from the start frame', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).toContain('non-solid');
    expect(t).toContain('start frame');
  });
});
