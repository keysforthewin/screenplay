// tests/promptConstraints.test.js
import { describe, it, expect } from 'vitest';
import { NO_TEXT_RULES } from '../src/web/promptConstraints.js';

describe('prompt constraints', () => {
  it('the no-text block is a non-empty string', () => {
    expect(typeof NO_TEXT_RULES).toBe('string');
    expect(NO_TEXT_RULES.trim().length).toBeGreaterThan(0);
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

  it('the cut-planner rule blocks are gone from the module', async () => {
    const mod = await import('../src/web/promptConstraints.js');
    expect(Object.keys(mod)).toEqual(['NO_TEXT_RULES']);
  });
});
