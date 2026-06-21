import { describe, it, expect } from 'vitest';
import { FACETS, getFacet, facetStubs } from '../src/web/critiqueFacets.js';

const MIN_CTX = {
  beat: { order: 2, name: 'Confrontation', desc: 'they clash', body: 'INT. ROOM — NIGHT\nThey clash.' },
  prevBeat: { order: 1, name: 'Setup', body: 'Setup body' },
  nextBeat: { order: 3, name: 'Fallout', body: 'Fallout body' },
  plot: { title: 'T', synopsis: 'A synopsis.' },
  spine: [{ order: 1, name: 'Setup', desc: 'd1' }, { order: 2, name: 'Confrontation', desc: 'd2' }],
  directorNotes: [{ text: 'Keep it tense.' }],
  characters: [{ name: 'Alice', hollywood_actor: '', fields: {} }],
  styleGuide: 'STYLE GUIDE TEXT',
};

describe('critique facet registry', () => {
  it('has 7 facets with unique keys', () => {
    expect(FACETS).toHaveLength(7);
    const keys = FACETS.map((f) => f.key);
    expect(new Set(keys).size).toBe(7);
  });

  it('marks exactly format + direction as required', () => {
    const req = FACETS.filter((f) => f.required).map((f) => f.key).sort();
    expect(req).toEqual(['direction', 'format']);
  });

  it('has exactly one story-scoped facet (story_fit)', () => {
    const story = FACETS.filter((f) => f.scope === 'story');
    expect(story.map((f) => f.key)).toEqual(['story_fit']);
  });

  it('every facet is well-formed and builds non-empty context', () => {
    for (const f of FACETS) {
      expect(typeof f.key).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(['focused', 'story']).toContain(f.scope);
      expect(typeof f.systemPrompt).toBe('string');
      expect(f.systemPrompt.length).toBeGreaterThan(20);
      expect(typeof f.buildContext).toBe('function');
      const text = f.buildContext(MIN_CTX);
      expect(typeof text).toBe('string');
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it('getFacet finds by key; facetStubs mirrors the registry', () => {
    expect(getFacet('format').label).toBe('Screenplay format');
    const stubs = facetStubs();
    expect(stubs).toHaveLength(7);
    expect(stubs[0]).toMatchObject({ score: null, comments: '', status: 'pending', error_message: null });
  });
});
