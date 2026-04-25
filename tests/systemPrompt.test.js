import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
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
    expect(out).toContain('(no beats yet)');
    expect(out).toContain('(none set)');
  });

  it('renders the current beat name when set', () => {
    const beatId = new ObjectId();
    const out = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: {
        synopsis: 'A test.',
        beats: [{ _id: beatId, order: 1, name: 'Diner Morning', desc: 'morning vibes', body: '' }],
        current_beat_id: beatId,
      },
    });
    expect(out).toContain('1 beat(s) outlined');
    expect(out).toContain('Current beat: "Diner Morning"');
    expect(out).toContain('1. Diner Morning');
    expect(out).toContain('morning vibes');
  });

  it('mentions Nano Banana and the explicit-only generation policy', () => {
    const out = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
    });
    expect(out).toContain('Nano Banana');
    expect(out).toMatch(/explicitly asked/i);
  });
});
