import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

describe('buildSystemPrompt', () => {
  it('includes character names and template fields', () => {
    const out = buildSystemPrompt({
      characters: [{ name: 'Alice' }, { name: 'Bob' }],
      characterTemplate: {
        fields: [
          { name: 'name', description: 'name', required: true, core: true },
          { name: 'favorite_color', description: 'fav color', required: false, core: false },
        ],
      },
      plotTemplate: { synopsis_guidance: 'g', beat_guidance: 'b' },
      plot: { synopsis: '', beats: [] },
    });
    expect(out).toContain('Alice');
    expect(out).toContain('Bob');
    expect(out).toContain('favorite_color');
    expect(out.toLowerCase()).toContain('plot');
  });

  it('handles empty state', () => {
    const out = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
    });
    expect(out).toContain('none yet');
  });
});
