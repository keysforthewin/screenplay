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
const Plots = await import('../src/mongo/plots.js');
const { config } = await import('../src/config.js');

beforeEach(() => {
  fakeDb.reset();
  tavilySearch.mockReset();
  analyzeTextMock.mockReset();
  config.tavily.apiKey = 'test-key';
});

describe('similar_works', () => {
  it('returns error when TAVILY_API_KEY is unset', async () => {
    config.tavily.apiKey = null;
    const out = await HANDLERS.similar_works({});
    expect(out).toMatch(/TAVILY_API_KEY/);
    expect(tavilySearch).not.toHaveBeenCalled();
  });

  it('returns error when plot is empty', async () => {
    const out = await HANDLERS.similar_works({});
    expect(out).toMatch(/no synopsis/i);
    expect(tavilySearch).not.toHaveBeenCalled();
    expect(analyzeTextMock).not.toHaveBeenCalled();
  });

  it('uses synopsis + beat outlines for plot scope', async () => {
    await Plots.updatePlot({
      synopsis: 'A young wizard discovers he is destined to defeat a dark lord at school.',
    });
    await Plots.createBeat({ name: 'Letter Arrives', desc: 'Mysterious letter arrives by owl post.' });
    await Plots.createBeat({ name: 'Magical School', desc: 'Boy travels to a school for wizards.' });
    tavilySearch.mockResolvedValue({
      results: [
        {
          title: 'Harry Potter',
          url: 'https://example.com/hp',
          content: 'A young wizard at a magical school',
          raw_content: 'Long page',
          score: 0.9,
        },
      ],
    });
    analyzeTextMock.mockResolvedValue('1. **Harry Potter** ...');
    const out = await HANDLERS.similar_works({});
    expect(tavilySearch).toHaveBeenCalledTimes(1);
    const tavilyArg = tavilySearch.mock.calls[0][0];
    expect(tavilyArg.query).toMatch(/^story plot similar to:/);
    expect(tavilyArg.query).toMatch(/young wizard/);
    expect(tavilyArg.query).toMatch(/owl post/);
    expect(out).toMatch(/Harry Potter/);
    expect(out).toMatch(/the current plot/);
  });

  it('uses one beat for beat scope', async () => {
    await Plots.updatePlot({ synopsis: 'something' });
    const beat = await Plots.createBeat({
      name: 'Diner Showdown',
      desc: 'Two former lovers argue at the diner.',
      body: 'Long form body of the diner scene.',
    });
    tavilySearch.mockResolvedValue({ results: [] });
    analyzeTextMock.mockResolvedValue('No strong parallels.');
    const out = await HANDLERS.similar_works({ scope: 'beat', beat: beat._id.toString() });
    const arg = tavilySearch.mock.calls[0][0];
    expect(arg.query).toMatch(/^scene similar to:/);
    expect(arg.query).toMatch(/argue/);
    expect(arg.query).toMatch(/diner/i);
    expect(out).toMatch(/beat #\d+ Diner Showdown/);
  });

  it('falls back to current beat when scope=beat and beat omitted', async () => {
    await Plots.updatePlot({ synopsis: 'x' });
    await Plots.createBeat({ name: 'First', desc: 'first beat unique-token-alpha' });
    await Plots.createBeat({ name: 'Second', desc: 'second beat unique-token-beta' });
    await Plots.setCurrentBeat('First');
    tavilySearch.mockResolvedValue({ results: [] });
    analyzeTextMock.mockResolvedValue('none');
    await HANDLERS.similar_works({ scope: 'beat' });
    const arg = tavilySearch.mock.calls[0][0];
    expect(arg.query).toMatch(/unique-token-alpha/);
    expect(arg.query).not.toMatch(/unique-token-beta/);
  });

  it('errors when scope=beat and target has no desc/body', async () => {
    const empty = await Plots.createBeat({ name: 'Empty Beat', desc: '' });
    const out = await HANDLERS.similar_works({ scope: 'beat', beat: empty._id.toString() });
    expect(out).toMatch(/no desc or body/i);
    expect(tavilySearch).not.toHaveBeenCalled();
    expect(analyzeTextMock).not.toHaveBeenCalled();
  });

  it('appends focus to the query', async () => {
    await Plots.updatePlot({ synopsis: 'A heist crew plans one last score.' });
    tavilySearch.mockResolvedValue({ results: [] });
    analyzeTextMock.mockResolvedValue('none');
    await HANDLERS.similar_works({ focus: 'heist films' });
    const arg = tavilySearch.mock.calls[0][0];
    expect(arg.query).toMatch(/heist films/);
  });
});
