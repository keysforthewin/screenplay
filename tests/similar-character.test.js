import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const tavilySearch = vi.fn();
vi.mock('../src/tavily/client.js', () => ({
  search: tavilySearch,
  fetchTavilyImageToTmp: vi.fn(),
}));

const analyzeTextMock = vi.fn();
vi.mock('../src/llm/analyze.js', () => ({
  analyzeText: analyzeTextMock,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const Characters = await import('../src/mongo/characters.js');
const { config } = await import('../src/config.js');

beforeEach(() => {
  fakeDb.reset();
  tavilySearch.mockReset();
  analyzeTextMock.mockReset();
  config.tavily.apiKey = 'test-key';
});

async function seedAtticus() {
  await Characters.createCharacter({
    name: 'Atticus',
    plays_self: false,
    hollywood_actor: 'Gregory Peck',
    own_voice: false,
    fields: {
      background_story:
        'A morally upright lawyer in 1930s small-town Alabama, raising two children alone',
      arc:
        'Defends a Black man wrongfully accused of assaulting a white woman, suffering social fallout',
      events: 'Trial scenes, threats from the accuser father, mockingbird metaphor',
    },
  });
}

describe('similar_character', () => {
  it('returns error when character is missing', async () => {
    const out = await HANDLERS.similar_character({});
    expect(out).toMatch(/required/i);
    expect(tavilySearch).not.toHaveBeenCalled();
    expect(analyzeTextMock).not.toHaveBeenCalled();
  });

  it('returns error when character is not found', async () => {
    const out = await HANDLERS.similar_character({ character: 'Ghost' });
    expect(out).toMatch(/No character found/);
    expect(tavilySearch).not.toHaveBeenCalled();
  });

  it('returns error when TAVILY_API_KEY is unset', async () => {
    await seedAtticus();
    config.tavily.apiKey = null;
    const out = await HANDLERS.similar_character({ character: 'Atticus' });
    expect(out).toMatch(/TAVILY_API_KEY/);
    expect(tavilySearch).not.toHaveBeenCalled();
    expect(analyzeTextMock).not.toHaveBeenCalled();
  });

  it('returns error when character has no descriptive fields', async () => {
    await Characters.createCharacter({
      name: 'Empty',
      plays_self: true,
      own_voice: true,
      fields: {},
    });
    const out = await HANDLERS.similar_character({ character: 'Empty' });
    expect(out).toMatch(/no descriptive fields/);
    expect(tavilySearch).not.toHaveBeenCalled();
  });

  it('builds a name-blind query, calls Tavily with raw content, calls analyze', async () => {
    await seedAtticus();
    tavilySearch.mockResolvedValue({
      results: [
        {
          title: 'To Kill a Mockingbird - Wikipedia',
          url: 'https://example.com/tkam',
          content:
            'Atticus Finch is a lawyer in 1930s Alabama defending a wrongfully accused Black man.',
          raw_content:
            'Long article about the novel, the film, and Gregory Peck Atticus Finch portrayal',
          score: 0.97,
        },
      ],
    });
    analyzeTextMock.mockResolvedValue(
      '1. **To Kill a Mockingbird** (1960) — Atticus Finch\n   Confidence: high\n   Evidence: matches\n   Source: https://example.com/tkam',
    );

    const out = await HANDLERS.similar_character({ character: 'Atticus', max_works: 2 });

    expect(tavilySearch).toHaveBeenCalledTimes(1);
    const tavilyArg = tavilySearch.mock.calls[0][0];
    expect(tavilyArg.query).not.toMatch(/Atticus/);
    expect(tavilyArg.query).toMatch(/Gregory Peck/);
    expect(tavilyArg.query).toMatch(/Alabama/);
    expect(tavilyArg.query).toMatch(/^fictional character archetype:/);
    expect(tavilyArg.include_raw_content).toBe(true);
    expect(tavilyArg.search_depth).toBe('advanced');

    expect(analyzeTextMock).toHaveBeenCalledTimes(1);
    const analyzeArg = analyzeTextMock.mock.calls[0][0];
    const profileMatch = analyzeArg.user.match(/<profile>\n([\s\S]*?)\n<\/profile>/);
    expect(profileMatch).toBeTruthy();
    expect(profileMatch[1]).not.toMatch(/Atticus/);
    expect(profileMatch[1]).toMatch(/Gregory Peck/);
    expect(analyzeArg.user).toMatch(/Wikipedia/);
    expect(analyzeArg.user).toMatch(/Long article/);
    expect(analyzeArg.system).toMatch(/up to 2/);

    expect(out).toMatch(/Atticus/);
    expect(out).toMatch(/To Kill a Mockingbird/);
    expect(out).toMatch(/query: `fictional character archetype:/);
  });

  it('appends focus to the query when provided', async () => {
    await Characters.createCharacter({
      name: 'Bob',
      plays_self: true,
      own_voice: true,
      fields: { background_story: 'A retired hitman returning to a life of violence' },
    });
    tavilySearch.mockResolvedValue({ results: [] });
    analyzeTextMock.mockResolvedValue('No strong parallels found.');
    await HANDLERS.similar_character({ character: 'Bob', focus: 'neo-noir thrillers' });
    const arg = tavilySearch.mock.calls[0][0];
    expect(arg.query).toMatch(/neo-noir thrillers/);
  });

  it('passes only top-3 raw_content to the analyzer (snippets-only beyond)', async () => {
    await seedAtticus();
    const fakeResults = Array.from({ length: 5 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `snippet ${i}`,
      raw_content: `RAW_BODY_${i}`,
      score: 1 - i * 0.1,
    }));
    tavilySearch.mockResolvedValue({ results: fakeResults });
    analyzeTextMock.mockResolvedValue('done');
    await HANDLERS.similar_character({ character: 'Atticus' });
    const userText = analyzeTextMock.mock.calls[0][0].user;
    expect(userText).toMatch(/RAW_BODY_0/);
    expect(userText).toMatch(/RAW_BODY_1/);
    expect(userText).toMatch(/RAW_BODY_2/);
    expect(userText).not.toMatch(/RAW_BODY_3/);
    expect(userText).not.toMatch(/RAW_BODY_4/);
    expect(userText).toMatch(/snippet 3/);
    expect(userText).toMatch(/snippet 4/);
  });
});
