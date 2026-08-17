// tests/storyboardConstraints.test.js
import { describe, it, expect } from 'vitest';
import {
  CAMERA_MOTION_RULES,
  STILL_FRAMING_RULES,
  VIDEO_PROMPT_RULES,
  OCCUPANT_PLACEHOLDER_RULES,
  CAMERA_COHERENCE_RULES,
  PERFORMANCE_RULES,
  CONTINUITY_STATE_RULES,
  ANTI_SLOP_RULES,
  SHOT_SIZE_FIDELITY_RULES,
  ENDING_PROFILE_RULES,
  FRAGILITY_RULES,
  NO_TEXT_RULES,
} from '../src/web/storyboardConstraints.js';

describe('storyboard constraints', () => {
  it('every block is a non-empty string', () => {
    for (const block of [
      CAMERA_MOTION_RULES,
      STILL_FRAMING_RULES,
      VIDEO_PROMPT_RULES,
      OCCUPANT_PLACEHOLDER_RULES,
      CAMERA_COHERENCE_RULES,
      PERFORMANCE_RULES,
      CONTINUITY_STATE_RULES,
      ANTI_SLOP_RULES,
      SHOT_SIZE_FIDELITY_RULES,
      ENDING_PROFILE_RULES,
      FRAGILITY_RULES,
      NO_TEXT_RULES,
    ]) {
      expect(typeof block).toBe('string');
      expect(block.trim().length).toBeGreaterThan(0);
    }
  });

  it('camera rules offer a preference ordering, not a ban list', () => {
    const t = CAMERA_MOTION_RULES.toLowerCase();
    expect(t).toContain('locked-off');
    expect(t).toContain('pan');
    // The NEVER list is gone — pans and cranes are available again.
    expect(t).not.toContain('never (these break the model)');
    expect(t).toContain('motivation');
  });

  it('video-prompt rules put the camera first and then demand performance', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).toContain('locked-off');
    expect(t).toContain('blocking');
    expect(t).toContain('performance');
  });

  it('video-prompt rules ban the stillness closer that killed listener beats', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    // Present only as a prohibition, never as a template to emit.
    expect(t).toContain('do not write');
    expect(t).toContain('everything else holds still');
    expect(t).not.toContain('verbatim: "everything else holds still');
  });

  it('video-prompt rules no longer cap the clip at one motion', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).not.toContain('one primary motion');
    expect(t).not.toContain('at most one hero temporal change');
  });

  it('video-prompt rules still strip static description into the still', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).toContain('strip all static description');
    expect(t).toContain('start_frame_prompt');
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

  it('still-framing rules drop the t=0 non-solid-effect withholding clause', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    expect(t).not.toContain('shooting star');
    expect(t).not.toContain('non-solid');
  });

  it('still-framing rules keep the readable-text warning rescued from FRAMING_RULES', () => {
    const t = STILL_FRAMING_RULES.toLowerCase();
    expect(t).toContain('gibberish');
  });

  it('occupant placeholders may now move', () => {
    const t = OCCUPANT_PLACEHOLDER_RULES.toLowerCase();
    expect(t).not.toContain('do not move');
  });

  it('performance rules name all five acting objectives', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('blocking');
    expect(t).toContain('speech turns');
    expect(t).toContain('facial beats');
    expect(t).toContain('listener behavior');
    expect(t).toContain('state change');
  });

  it('performance rules forbid writing the words themselves (survives the SUBJECT_MOTION_RULES deletion)', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('never write the words');
    expect(t).toContain('voice-over');
    expect(t).toContain('sound effects');
    expect(t).toContain('lip-synced in post');
  });

  it('performance rules demand an expression change, not a static expression', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('start state');
    expect(t).toContain('end state');
  });

  it('performance rules require a beat for every non-speaking listener', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('never neutral');
    expect(t).toContain('each listener');
  });

  it('continuity-state rules make wardrobe drift explicit and carry it forward', () => {
    const t = CONTINUITY_STATE_RULES.toLowerCase();
    expect(t).toContain('default look');
    expect(t).toContain('reverts to the reference');
    expect(t).toContain('carry it forward');
    expect(t).toContain('differs from the default');
  });

  it('continuity-state rules join the still to the in-clip state change', () => {
    const t = CONTINUITY_STATE_RULES.toLowerCase();
    expect(t).toContain('state before it');
    expect(t).toContain('video_prompt performs the change');
    expect(t).toContain('state after');
  });

  it('anti-slop rules name the banned evaluators and give the visibility test', () => {
    const t = ANTI_SLOP_RULES.toLowerCase();
    for (const word of ['cinematic', 'epic', 'stunning', 'beautiful', 'dramatic', '8k', 'masterpiece']) {
      expect(t).toContain(word);
    }
    expect(t).toContain('light meter');
    expect(t).toContain('stopwatch');
  });

  it('anti-slop rules ban negation and demand the positive state instead', () => {
    const t = ANTI_SLOP_RULES.toLowerCase();
    expect(t).toContain('no negation');
    expect(t).toContain('summon exactly what they forbid');
    expect(t).toContain('positive state');
  });

  it('anti-slop rules spare genre language that carries concrete direction', () => {
    const t = ANTI_SLOP_RULES.toLowerCase();
    expect(t).toContain('venetian-blind');
    expect(t).toContain('is allowed');
  });

  it('shot-size rules refuse facial acting at wide sizes and force one primary spend', () => {
    const t = SHOT_SIZE_FIDELITY_RULES.toLowerCase();
    expect(t).toContain('establishing');
    expect(t).toContain('too small to act');
    expect(t).toContain('one primary spend per shot');
    expect(t).toContain('two shots');
  });

  it('ending rules demand a completed endpoint without prescribing stillness', () => {
    const t = ENDING_PROFILE_RULES.toLowerCase();
    expect(t).toContain('edit point');
    expect(t).toContain('motion handoff');
    expect(t).toContain('unmatched');
    expect(t).toContain('must differ from the first');
    // The purged doctrine must not come back in through the endpoint door.
    expect(t).not.toContain('everything else holds still');
  });

  it('video-prompt rules close on the endpoint and ask for cause-and-consequence', () => {
    const t = VIDEO_PROMPT_RULES.toLowerCase();
    expect(t).toContain('endpoint');
    expect(t).toContain('cause and consequence, not a list');
  });

  it('performance rules convert emotion into behavior and assign ensemble tiers', () => {
    const t = PERFORMANCE_RULES.toLowerCase();
    expect(t).toContain('emotion is not directable');
    expect(t).toContain('persistent micro-motion');
    expect(t).toContain('one focused beat');
    expect(t).toContain('large action');
  });

  it('fragility rules cover the known-breaking areas', () => {
    const t = FRAGILITY_RULES.toLowerCase();
    for (const risk of ['logos', 'hands', 'contact', 'camera move']) {
      expect(t).toContain(risk);
    }
  });

  it('no-text rules name post-production as the reason, not gibberish risk', () => {
    const t = NO_TEXT_RULES.toLowerCase();
    expect(t).toContain('post-production');
    for (const kind of ['title card', 'caption', 'subtitle', 'chyron', 'watermark', 'signage']) {
      expect(t).toContain(kind);
    }
  });

  it('no-text rules state the empty surface positively (a prohibition plants the lettering)', () => {
    const t = NO_TEXT_RULES.toLowerCase();
    expect(t).toContain('blank unlettered marquee letterboard');
    expect(t).toContain('smooth empty sign panel');
    expect(t).toContain('positively');
  });

  it('no-text rules refuse a shot whose subject is text, and freeze it for the clip', () => {
    const t = NO_TEXT_RULES.toLowerCase();
    expect(t).toContain('subject is text is not a shot');
    expect(t).toContain('animates on');
  });

  it('no-text rules keep the two narrow exceptions (reference edits, worn printing)', () => {
    const t = NO_TEXT_RULES.toLowerCase();
    expect(t).toContain('never repaint them blank');
    expect(t).toContain('garment graphic');
  });

  it('the fragility and still-framing text bullets no longer allow soft-focus lettering', () => {
    // The old escape hatch: letter the sign, just keep it small or out of focus.
    for (const block of [FRAGILITY_RULES, STILL_FRAMING_RULES]) {
      const t = block.toLowerCase();
      expect(t).toContain('unlettered');
      expect(t).not.toContain('out of focus');
    }
  });

  it('the retired blocks are gone from the module', async () => {
    const mod = await import('../src/web/storyboardConstraints.js');
    expect(mod.SUBJECT_MOTION_RULES).toBeUndefined();
    expect(mod.REVEAL_HANDLING).toBeUndefined();
    expect(mod.FRAMING_RULES).toBeUndefined();
  });
});
