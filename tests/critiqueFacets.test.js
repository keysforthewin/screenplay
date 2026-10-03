import { describe, it, expect } from 'vitest';
import { FACETS, getFacet, facetStubs, criteriaKeys } from '../src/web/critiqueFacets.js';

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

  it('the format facet judges layout only; staging lives in cinematic craft at half weight', () => {
    const fmt = getFacet('format');
    expect(criteriaKeys(fmt)).toEqual(['sluglines', 'action_lines', 'dialogue_format', 'screen_text']);
    expect(fmt.systemPrompt).toContain('LAYOUT ONLY');
    expect(fmt.systemPrompt.toLowerCase()).toContain('mini-slug');
    expect(fmt.systemPrompt.toLowerCase()).not.toContain('geography');
    const staging = getFacet('cinematic').criteria.find((c) => c.key === 'staging');
    expect(staging).toMatchObject({ optional: true, weight: 0.5 });
    expect(staging.anchors[9]).toContain('never raise more than a should_fix');
  });

  it('where the story goes is never a fault', () => {
    for (const f of FACETS) expect(f.systemPrompt).toContain('out into space');
    expect(getFacet('story_fit').systemPrompt).toContain('A jump to another place, planet or time between beats');
    expect(getFacet('dialogue').systemPrompt).toContain('is not dialogue');
  });

  it('getFacet finds by key; facetStubs mirrors the registry', () => {
    expect(getFacet('format').label).toBe('Screenplay format');
    const stubs = facetStubs();
    expect(stubs).toHaveLength(7);
    expect(stubs[0]).toMatchObject({
      key: 'format',
      label: 'Screenplay format',
      scope: 'focused',
      score: null,
      comments: '',
      summary: '',
      strengths: [],
      criteria: [],
      issues: [],
      status: 'pending',
      error_message: null,
    });
  });

  it('every facet has 3-4 criteria with unique keys and 3/6/9 anchors, and the prompt lists them', () => {
    for (const f of FACETS) {
      expect(f.criteria.length).toBeGreaterThanOrEqual(3);
      expect(f.criteria.length).toBeLessThanOrEqual(4);
      expect(new Set(criteriaKeys(f)).size).toBe(f.criteria.length);
      for (const c of f.criteria) {
        for (const a of [3, 6, 9]) expect(c.anchors[a].length).toBeGreaterThan(10);
        expect(f.systemPrompt).toContain(`[${c.key}]`);
        expect(f.systemPrompt).toContain(c.anchors[9]);
      }
      expect(f.systemPrompt).toContain('# Scoring rules');
    }
    expect(criteriaKeys(getFacet('cinematic'))).toContain('staging');
  });

  it('required facets weigh 1.5, the rest 1', () => {
    for (const f of FACETS) expect(f.weight).toBe(f.required ? 1.5 : 1);
  });

  it('feeds the steering documents and full profiles into the right facets', () => {
    const ctx = {
      ...MIN_CTX,
      plot: { ...MIN_CTX.plot, dialogue_style: 'STYLE-SAMPLE-TEXT' },
      directorialVoice: 'VOICE-TEXT',
      sceneBible: 'Intention: BIBLE-TEXT',
      characters: [{ name: 'Alice', hollywood_actor: 'Jodie Comer', fields: { backstory: 'BACKSTORY-TEXT' } }],
      sets: [{ name: 'Kitchen', description: 'SET-DESC-TEXT' }],
    };
    const direction = getFacet('direction').buildContext(ctx);
    expect(direction).toContain('VOICE-TEXT');
    expect(direction).toContain('BIBLE-TEXT');
    expect(getFacet('dialogue').buildContext(ctx)).toContain('STYLE-SAMPLE-TEXT');
    const voice = getFacet('voice').buildContext(ctx);
    expect(voice).toContain('Jodie Comer');
    expect(voice).toContain('BACKSTORY-TEXT');
    expect(getFacet('format').buildContext(ctx)).not.toContain('SET-DESC-TEXT');
    expect(getFacet('cinematic').buildContext(ctx)).toContain('SET-DESC-TEXT');
    // absent optional documents are flagged as not applicable, never invented
    expect(getFacet('direction').buildContext(MIN_CTX)).toContain('not applicable');
  });
});

describe('wardrobe in the text critique', () => {
  const keys = { _id: '64b000000000000000000001', name: 'Young Keys', fields: { wardrobe: 'short-sleeved striped tee', role: 'the kid' } };

  it('shows the character wardrobe to the voice critic as a default, not a lock', async () => {
    const { formatCharacterFull } = await import('../src/web/beatContext.js');
    const { charactersFullText, getFacet: facetOf } = await import('../src/web/critiqueFacets.js');
    const text = charactersFullText([keys], { wardrobe_overrides: {} });
    expect(text).toContain('usual wardrobe (a default, not a rule');
    expect(text).toContain('short-sleeved striped tee');
    expect(text).not.toContain('LOCKED');
    expect(facetOf('voice').systemPrompt).toContain('dressed for the scene\'s weather');
    // The picture pipeline still gets the lock.
    expect(formatCharacterFull(keys)).toContain('wardrobe (LOCKED');
  });

  it('a wardrobe set for this beat is shown as binding', async () => {
    const { charactersFullText } = await import('../src/web/critiqueFacets.js');
    const text = charactersFullText([keys], { wardrobe_overrides: { [keys._id]: 'striped long-sleeve under a windbreaker' } });
    expect(text).toContain('wardrobe in THIS beat');
    expect(text).toContain('windbreaker');
    expect(text).not.toContain('short-sleeved');
  });
});

describe('the critics read the page with its line breaks', () => {
  it('keeps sluglines, cues and speeches on their own lines and strips the markdown marks', () => {
    const facet = getFacet('format');
    const body = 'INT. LOBBY — **NIGHT**\n\nKEYS\\\n(flat)\\\nCompliance.\n\n> crawl line';
    const text = facet.buildContext({ styleGuide: 'G', sets: [], beat: { order: 1, name: 'B', desc: 'd', body } });
    expect(text).toContain('INT. LOBBY — NIGHT\n\nKEYS\n(flat)\nCompliance.\n\ncrawl line');
    expect(text).not.toContain('KEYS (flat)');
  });
});
