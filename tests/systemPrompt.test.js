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

  it('renders Recently touched section sorted by updated_at desc when there is signal', () => {
    const beats = [];
    const baseTs = Date.now();
    for (let i = 1; i <= 6; i++) {
      beats.push({
        _id: new ObjectId(),
        order: i,
        name: `Beat ${i}`,
        desc: `desc ${i}`,
        body: '',
        characters: [],
        images: [],
        main_image_id: null,
        created_at: new Date(baseTs),
        updated_at: new Date(baseTs + i * 1000),
      });
    }
    const out = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats },
    });
    expect(out).toContain('Recently touched (last 5):');
    const recentSection = out.split('Recently touched')[1].split('Beats:')[0];
    // Most recent is Beat 6; oldest in window is Beat 2; Beat 1 should NOT appear in the recent slice.
    const idx6 = recentSection.indexOf('Beat 6');
    const idx5 = recentSection.indexOf('Beat 5');
    const idx2 = recentSection.indexOf('Beat 2');
    expect(idx6).toBeGreaterThan(-1);
    expect(idx5).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(-1);
    expect(idx6).toBeLessThan(idx5);
    expect(idx5).toBeLessThan(idx2);
    expect(recentSection).not.toContain('Beat 1');
  });

  it('omits Recently touched when fewer than 3 beats exist', () => {
    const out = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: {
        synopsis: '',
        beats: [
          { _id: new ObjectId(), order: 1, name: 'A', desc: 'a', body: '', characters: [], images: [], main_image_id: null, updated_at: new Date() },
          { _id: new ObjectId(), order: 2, name: 'B', desc: 'b', body: '', characters: [], images: [], main_image_id: null, updated_at: new Date() },
        ],
      },
    });
    expect(out).not.toContain('Recently touched (last');
  });

  it('omits Recently touched when all beats share one timestamp (low signal)', () => {
    const ts = new Date();
    const out = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: {
        synopsis: '',
        beats: [
          { _id: new ObjectId(), order: 1, name: 'A', desc: 'a', body: '', characters: [], images: [], main_image_id: null, updated_at: ts },
          { _id: new ObjectId(), order: 2, name: 'B', desc: 'b', body: '', characters: [], images: [], main_image_id: null, updated_at: ts },
          { _id: new ObjectId(), order: 3, name: 'C', desc: 'c', body: '', characters: [], images: [], main_image_id: null, updated_at: ts },
        ],
      },
    });
    expect(out).not.toContain('Recently touched (last');
  });

  it('includes the brainstorming and reference-resolution sections', () => {
    const out = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
    });
    expect(out).toContain('# Brainstorming bursts');
    expect(out).toContain('# Reference resolution & focus');
    expect(out).toMatch(/parallel `tool_use` blocks/);
    expect(out).toMatch(/Don't `set_current_beat` reflexively/i);
  });
});
