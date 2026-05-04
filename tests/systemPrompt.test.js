import { describe, it, expect } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  buildSystemPrompt,
  joinSystemBlocks,
  _resetStableTextCacheForTests,
} from '../src/agent/systemPrompt.js';

function joined(args) {
  return joinSystemBlocks(buildSystemPrompt(args));
}

describe('buildSystemPrompt', () => {
  it('returns an array of two cache-controlled text blocks by default', () => {
    const blocks = buildSystemPrompt({
      characters: [{ name: 'Alice' }],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: 'g', beat_guidance: 'b' },
      plot: { synopsis: '', beats: [] },
    });
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) {
      expect(b.type).toBe('text');
      expect(typeof b.text).toBe('string');
      expect(b.cache_control).toEqual({ type: 'ephemeral' });
    }
  });

  it('omits cache_control when cache: false', () => {
    const blocks = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
      cache: false,
    });
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b.cache_control).toBeUndefined();
  });

  it('puts character/beat current state in the volatile block, templates in the stable block', () => {
    const blocks = buildSystemPrompt({
      characters: [{ name: 'Zorblax' }],
      characterTemplate: {
        fields: [
          { name: 'name', description: 'name', required: true, core: true },
          { name: 'favorite_color', description: 'fav color', required: false, core: false },
        ],
      },
      plotTemplate: { synopsis_guidance: 'g', beat_guidance: 'b' },
      plot: { synopsis: '', beats: [] },
    });
    const [stable, volatile] = blocks;
    expect(stable.text).toContain('favorite_color');
    expect(stable.text).toContain('Synopsis guidance: g');
    expect(stable.text).not.toContain('Zorblax');
    expect(volatile.text).toContain('Zorblax');
    expect(volatile.text).toContain('# Current state');
  });

  it('stable block is byte-identical when only volatile inputs change', () => {
    _resetStableTextCacheForTests();
    const args1 = {
      characters: [{ name: 'Alice' }],
      characterTemplate: { fields: [{ name: 'name', description: 'n', required: true }] },
      plotTemplate: { synopsis_guidance: 'g', beat_guidance: 'b' },
      plot: { synopsis: '', beats: [] },
    };
    const args2 = {
      ...args1,
      characters: [{ name: 'Bob' }, { name: 'Carol' }],
      plot: {
        synopsis: 'A test.',
        beats: [{ order: 1, name: 'Beat One', desc: 'd', body: '' }],
      },
    };
    const [s1] = buildSystemPrompt(args1);
    const [s2] = buildSystemPrompt(args2);
    expect(s1.text).toBe(s2.text);
  });

  it('stable block changes when characterTemplate changes', () => {
    _resetStableTextCacheForTests();
    const base = {
      characters: [],
      plotTemplate: { synopsis_guidance: 'g', beat_guidance: 'b' },
      plot: { synopsis: '', beats: [] },
    };
    const [s1] = buildSystemPrompt({
      ...base,
      characterTemplate: { fields: [{ name: 'a', description: 'x', required: false }] },
    });
    const [s2] = buildSystemPrompt({
      ...base,
      characterTemplate: { fields: [{ name: 'b', description: 'y', required: true }] },
    });
    expect(s1.text).not.toBe(s2.text);
  });

  it('renders director notes in the volatile block', () => {
    const [, volatile] = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
      directorNotes: { notes: [{ text: 'every scene needs rain' }] },
    });
    expect(volatile.text).toContain("Director's Notes");
    expect(volatile.text).toContain('every scene needs rain');
  });

  it('skips director notes block entirely when directorNotes is null', () => {
    const [, volatile] = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
      directorNotes: null,
    });
    expect(volatile.text).not.toContain("Director's Notes");
  });

  // Below: original behavioral assertions, now run on the joined text.

  it('includes character names and template fields', () => {
    const out = joined({
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
    const out = joined({
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
    const out = joined({
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
    const out = joined({
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
    const out = joined({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats },
    });
    expect(out).toContain('Recently touched (last 5):');
    const recentSection = out.split('Recently touched (last ')[1].split('Beats:')[0];
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
    const out = joined({
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
    const out = joined({
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

  it('instructs the agent to suppress optional follow-up questions and emit a bullet-list mutation summary', () => {
    const out = joined({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
    });
    expect(out).toMatch(/one bullet per change/i);
    expect(out).toMatch(/Questions are reserved for these cases/i);
    expect(out).toMatch(/Don't follow up about optional fields/i);
  });

  it('describes the lazy tool-loading model with tool_search', () => {
    const out = joined({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
    });
    expect(out).toContain('# Tool loading');
    expect(out).toMatch(/loaded on demand/i);
    expect(out).toContain('tool_search');
    expect(out).toContain('get_overview');
    expect(out).toContain('search_message_history');
  });

  it('renders casting status next to each character name in the volatile block', () => {
    const [, volatile] = buildSystemPrompt({
      characters: [
        { name: 'Alice', plays_self: true },
        { name: 'Bob', plays_self: false, hollywood_actor: 'Bob Saget' },
        { name: 'Carol', plays_self: false, hollywood_actor: null },
      ],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: '', beat_guidance: '' },
      plot: { synopsis: '', beats: [] },
      cache: false,
    });
    expect(volatile.text).toContain('- Alice (plays self)');
    expect(volatile.text).toContain('- Bob (played by Bob Saget)');
    expect(volatile.text).toContain('- Carol (played by (unspecified))');
  });

  it('instructs the model to ground attribute-existence questions in tool data', () => {
    const [stable] = buildSystemPrompt({
      characters: [],
      characterTemplate: { fields: [] },
      plotTemplate: { synopsis_guidance: 'g', beat_guidance: 'b' },
      plot: { synopsis: '', beats: [] },
      cache: false,
    });
    expect(stable.text).toContain('# Attribute-existence questions');
    expect(stable.text).toMatch(/never infer casting/i);
    expect(stable.text).toMatch(/matched_fields/);
  });

  it('includes the brainstorming and reference-resolution sections', () => {
    const out = joined({
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
