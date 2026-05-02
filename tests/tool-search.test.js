import { describe, it, expect } from 'vitest';
import { searchTools, scoreTool, tokenize } from '../src/agent/toolSearch.js';
import { TOOLS, CORE_TOOL_NAMES, toolDefsForApi } from '../src/agent/tools.js';

describe('toolSearch.tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Add Image To Beat')).toEqual(['add', 'image', 'beat']);
  });
  it('drops stopwords', () => {
    expect(tokenize('add an image to the beat')).toEqual(['add', 'image', 'beat']);
  });
  it('handles null/undefined/empty', () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('toolSearch.scoreTool', () => {
  const tool = {
    name: 'add_image_to_beat',
    description: 'Attach an image to a beat',
    keywords: ['picture', 'photo', 'attach'],
  };
  it('rewards name matches more than description matches', () => {
    const nameScore = scoreTool(tokenize('beat'), tool);
    const descOnly = scoreTool(tokenize('attach'), tool);
    expect(nameScore).toBeGreaterThan(0);
    expect(descOnly).toBeGreaterThan(0);
    // 'beat' hits name (×3) + description (×1) = 4
    // 'attach' hits keywords (×2) + description (×1) = 3
    expect(nameScore).toBeGreaterThan(descOnly);
  });
  it('returns 0 for empty query', () => {
    expect(scoreTool([], tool)).toBe(0);
  });
  it('matches keyword synonyms', () => {
    const score = scoreTool(tokenize('picture'), tool);
    expect(score).toBeGreaterThan(0);
  });
  it('handles tools without keywords', () => {
    const t = { name: 'foo_bar', description: 'do the foo to a bar' };
    expect(scoreTool(tokenize('foo'), t)).toBeGreaterThan(0);
  });
});

describe('toolSearch.searchTools', () => {
  // Recall expectations: each query MUST return at least one of the listed tools
  // in the top results. These represent the kinds of phrasings users actually
  // use vs. the tool names we picked.
  const recallExpectations = [
    { query: 'export pdf', expectAny: ['export_pdf'] },
    { query: 'download the screenplay', expectAny: ['export_pdf'] },
    { query: 'add image to beat', expectAny: ['add_beat_image', 'generate_image'] },
    { query: 'attach picture to scene', expectAny: ['add_beat_image'] },
    { query: 'delete a character', expectAny: ['delete_character'] },
    { query: 'remove a character', expectAny: ['delete_character'] },
    { query: 'create new beat', expectAny: ['create_beat'] },
    { query: 'create character', expectAny: ['create_character'] },
    { query: 'look up movie', expectAny: ['tmdb_search_movie'] },
    { query: 'who played the role', expectAny: ['tmdb_get_movie_credits'] },
    { query: 'web search', expectAny: ['tavily_search'] },
    { query: 'generate an image', expectAny: ['generate_image'] },
    { query: 'edit existing image', expectAny: ['edit_image'] },
    { query: 'find similar work', expectAny: ['similar_works', 'similar_character'] },
    { query: 'check repeated phrases', expectAny: ['find_repeated_phrases'] },
    { query: 'export csv spreadsheet', expectAny: ['export_csv'] },
    { query: 'set current beat', expectAny: ['set_current_beat'] },
    { query: 'add director note', expectAny: ['add_director_note'] },
    { query: 'list characters', expectAny: ['list_characters'] },
    { query: 'arithmetic calculator', expectAny: ['calculator'] },
    { query: 'run javascript code', expectAny: ['run_code'] },
    { query: 'attach file to beat', expectAny: ['add_beat_attachment'] },
  ];

  for (const { query, expectAny } of recallExpectations) {
    it(`"${query}" → matches one of [${expectAny.join(', ')}]`, () => {
      const results = searchTools(query, { limit: 8 });
      const hit = expectAny.find((name) => results.includes(name));
      expect(
        hit,
        `expected one of [${expectAny.join(', ')}] in top 8 for "${query}", got: ${results.join(', ')}`,
      ).toBeTruthy();
    });
  }

  it('returns empty array for empty query', () => {
    expect(searchTools('')).toEqual([]);
    expect(searchTools('   ')).toEqual([]);
    expect(searchTools(null)).toEqual([]);
  });

  it('respects the limit option', () => {
    const r2 = searchTools('character', { limit: 2 });
    expect(r2.length).toBeLessThanOrEqual(2);
    const r10 = searchTools('character', { limit: 10 });
    expect(r10.length).toBeGreaterThan(r2.length);
    expect(r10.length).toBeLessThanOrEqual(10);
  });

  it('clamps limit to [1, 25]', () => {
    expect(searchTools('character', { limit: 0 }).length).toBeLessThanOrEqual(1);
    expect(searchTools('character', { limit: 9999 }).length).toBeLessThanOrEqual(25);
  });

  it('respects the exclude option', () => {
    const all = searchTools('list characters', { limit: 10 });
    expect(all).toContain('list_characters');
    const excl = searchTools('list characters', { limit: 10, exclude: new Set(['list_characters']) });
    expect(excl).not.toContain('list_characters');
  });

  it('does not return tool_search itself when excluded', () => {
    const r = searchTools('search find lookup tool', { limit: 8, exclude: new Set(['tool_search']) });
    expect(r).not.toContain('tool_search');
  });
});

describe('CORE_TOOL_NAMES', () => {
  it('includes tool_search and a small read-only inspection set', () => {
    expect(CORE_TOOL_NAMES.has('tool_search')).toBe(true);
    expect(CORE_TOOL_NAMES.has('get_overview')).toBe(true);
    expect(CORE_TOOL_NAMES.size).toBeLessThanOrEqual(10);
  });
  it('every name in CORE_TOOL_NAMES exists in TOOLS', () => {
    for (const name of CORE_TOOL_NAMES) {
      const found = TOOLS.find((t) => t.name === name);
      expect(found, `${name} not in TOOLS`).toBeTruthy();
    }
  });
});

describe('toolDefsForApi', () => {
  it('returns only tools whose names are in the set, preserving TOOLS order', () => {
    const names = new Set(['create_beat', 'list_characters', 'tool_search']);
    const out = toolDefsForApi(names);
    expect(out.map((t) => t.name)).toEqual(['tool_search', 'list_characters', 'create_beat']);
  });
  it('strips internal-only fields (keywords, metaTool) before returning', () => {
    const out = toolDefsForApi(new Set(['tool_search']));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('tool_search');
    expect(out[0].keywords).toBeUndefined();
    expect(out[0].metaTool).toBeUndefined();
    expect(out[0].input_schema).toBeDefined();
  });
  it('returns empty array for empty input', () => {
    expect(toolDefsForApi(new Set())).toEqual([]);
    expect(toolDefsForApi([])).toEqual([]);
    expect(toolDefsForApi(null)).toEqual([]);
  });
  it('accepts an array of names too', () => {
    const out = toolDefsForApi(['create_beat']);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('create_beat');
  });
});
