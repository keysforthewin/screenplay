import { describe, it, expect } from 'vitest';
import {
  detectReviewIntent,
  reviewInterceptText,
  REVIEW_MODE_SUFFIX,
} from '../src/agent/reviewMode.js';

describe('detectReviewIntent', () => {
  it('returns false for null / empty / whitespace input', () => {
    expect(detectReviewIntent(null)).toBe(false);
    expect(detectReviewIntent(undefined)).toBe(false);
    expect(detectReviewIntent('')).toBe(false);
    expect(detectReviewIntent('   ')).toBe(false);
    expect(detectReviewIntent(123)).toBe(false);
  });

  it('returns false for a typical edit command without review intent', () => {
    expect(detectReviewIntent('add a line to beat 26 saying Alice slams the door')).toBe(false);
    expect(detectReviewIntent('rewrite the body of beat 7')).toBe(false);
    expect(detectReviewIntent('create a character named Steve')).toBe(false);
    expect(detectReviewIntent('hi')).toBe(false);
  });

  describe('triggers (no override)', () => {
    const cases = [
      'context analyze and create impact gravitas for the body of beat26 and let me review',
      'tighten the dialogue, but let me review first',
      'rewrite this beat, send it for my review',
      'let me preview the new body',
      "I'd like to see the plan",
      "i would like to review the changes",
      'can you show me the changes before applying',
      'could we see the diff first',
      'before you change anything, what would you do',
      'before you edit the body, sketch a plan',
      'do a dry run',
      'dry-run this',
      'propose changes for beat 5',
      'propose a plan',
      'draft a plan for beat 3',
      'show me the plan',
      'show me the diff',
      'what would you change in this beat?',
      "don't apply anything yet",
      "don't change it yet",
      'no changes yet, just plan',
      'preview the changes please',
      'hold off on actually writing',
    ];
    for (const text of cases) {
      it(`triggers on: "${text}"`, () => {
        expect(detectReviewIntent(text)).toBe(true);
      });
    }
  });

  describe('overrides suppress review-mode', () => {
    const cases = [
      'let me review — actually just do it',
      'review and apply',
      'preview the changes, then go ahead',
      'draft a plan and apply it',
      'show me the plan but execute now',
      'what would you change? proceed',
      "don't change it yet — actually go ahead",
      'dry run, then commit',
      "I'd like to see the plan but write it now",
      'no changes yet, just kidding, do it now',
    ];
    for (const text of cases) {
      it(`overrides on: "${text}"`, () => {
        expect(detectReviewIntent(text)).toBe(false);
      });
    }
  });

  describe('false-positive guards', () => {
    it('plain "do it" / "go ahead" alone never triggers (no triggers present)', () => {
      expect(detectReviewIntent('do it')).toBe(false);
      expect(detectReviewIntent('go ahead')).toBe(false);
      expect(detectReviewIntent('proceed')).toBe(false);
      expect(detectReviewIntent('apply')).toBe(false);
    });

    it('"show me the image" / "show me the library" do not trigger', () => {
      expect(detectReviewIntent('show me the image for Alice')).toBe(false);
      expect(detectReviewIntent('show me the library')).toBe(false);
      expect(detectReviewIntent('show me beat 5')).toBe(false);
      expect(detectReviewIntent('show me everything')).toBe(false);
    });

    it('"review the image on file" / similar read intents do not trigger', () => {
      // None of these phrases hit our trigger set:
      // - bare "review" without "let me" / "for my" / "and propose" doesn't match.
      // - "see the image" doesn't hit "see (plan|changes|diff|edits|updates|proposals)".
      expect(detectReviewIntent("review the image on file for Alice")).toBe(false);
      expect(detectReviewIntent("let me see the diner beat")).toBe(false);
      expect(detectReviewIntent('can I see the main image for Bob')).toBe(false);
    });

    it('case-insensitive matching', () => {
      expect(detectReviewIntent('LET ME REVIEW')).toBe(true);
      expect(detectReviewIntent('Let Me Review')).toBe(true);
      expect(detectReviewIntent('DRY RUN')).toBe(true);
    });
  });
});

describe('REVIEW_MODE_SUFFIX', () => {
  it('contains the disclosure line', () => {
    expect(REVIEW_MODE_SUFFIX).toMatch(/No changes will be made until you confirm/);
  });

  it('describes the plan format', () => {
    expect(REVIEW_MODE_SUFFIX).toContain('Proposed plan');
    expect(REVIEW_MODE_SUFFIX).toContain('Before:');
    expect(REVIEW_MODE_SUFFIX).toContain('After:');
  });

  it('forbids mutation tool calls', () => {
    expect(REVIEW_MODE_SUFFIX).toMatch(/Do not call mutation tools/);
  });
});

describe('reviewInterceptText', () => {
  it('names the blocked tool and tells the model not to retry', () => {
    const out = reviewInterceptText('set_beat_body');
    expect(out).toContain('`set_beat_body`');
    expect(out).toContain('NOT executed');
    expect(out).toMatch(/Do not retry mutating tools/);
    expect(out).toMatch(/No changes will be made until you confirm/);
  });

  it('handles missing/empty tool name gracefully', () => {
    expect(reviewInterceptText(null)).toContain('a mutation tool');
    expect(reviewInterceptText('')).toContain('a mutation tool');
    expect(reviewInterceptText(undefined)).toContain('a mutation tool');
  });
});
