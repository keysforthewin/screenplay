import { describe, it, expect } from 'vitest';
import { SCREENPLAY_STYLE_GUIDE, SCREENPLAY_STYLE_SUMMARY } from '../src/agent/screenplayStyle.js';

describe('screenplay style text', () => {
  it('exports a non-empty full guide covering the key craft elements', () => {
    expect(typeof SCREENPLAY_STYLE_GUIDE).toBe('string');
    expect(SCREENPLAY_STYLE_GUIDE.length).toBeGreaterThan(200);
    // slugline convention
    expect(SCREENPLAY_STYLE_GUIDE).toContain('INT.');
    // photographable action lines
    expect(SCREENPLAY_STYLE_GUIDE.toLowerCase()).toContain('photographable');
    // sparing camera cues
    expect(SCREENPLAY_STYLE_GUIDE).toContain('CLOSE ON');
    // baseline dialogue
    expect(SCREENPLAY_STYLE_GUIDE.toLowerCase()).toContain('dialogue');
    // reformat-on-request
    expect(SCREENPLAY_STYLE_GUIDE.toLowerCase()).toContain('reformat');
  });

  it('exports a short summary that points back to load_writing_context', () => {
    expect(typeof SCREENPLAY_STYLE_SUMMARY).toBe('string');
    expect(SCREENPLAY_STYLE_SUMMARY.length).toBeGreaterThan(0);
    expect(SCREENPLAY_STYLE_SUMMARY.length).toBeLessThan(600);
    expect(SCREENPLAY_STYLE_SUMMARY).toContain('screenplay action');
    expect(SCREENPLAY_STYLE_SUMMARY).toContain('load_writing_context');
  });
});
