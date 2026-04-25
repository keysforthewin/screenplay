import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/tavily/client.js', () => ({
  search: vi.fn(),
  fetchTavilyImageToTmp: vi.fn(),
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const Tavily = await import('../src/tavily/client.js');
const { config } = await import('../src/config.js');

beforeEach(() => {
  config.tavily.apiKey = 'test-key';
  Tavily.search.mockReset();
  Tavily.fetchTavilyImageToTmp.mockReset();
});

describe('tavily_search', () => {
  it('returns answer + trimmed results + sliced images', async () => {
    Tavily.search.mockResolvedValue({
      query: 'naomi klein',
      answer: 'A summary of Naomi Klein.',
      results: Array.from({ length: 7 }).map((_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        content: 'Long content '.repeat(100),
        score: 1 - i * 0.1,
      })),
      images: Array.from({ length: 6 }).map((_, i) => ({
        url: `https://img.example.com/${i}.jpg`,
        description: `Image ${i}`,
      })),
    });
    const out = JSON.parse(await HANDLERS.tavily_search({ query: 'naomi klein' }));
    expect(out.query).toBe('naomi klein');
    expect(out.answer).toBe('A summary of Naomi Klein.');
    expect(out.results).toHaveLength(5);
    expect(out.results[0]).toMatchObject({
      title: 'Result 0',
      url: 'https://example.com/0',
      score: 1,
    });
    expect(out.results[0].snippet.length).toBeLessThanOrEqual(600);
    expect(out.images).toHaveLength(5);
    expect(out.images[0]).toEqual({
      url: 'https://img.example.com/0.jpg',
      description: 'Image 0',
    });
  });

  it('forwards optional params (depth, topic, time_range, domains, max_results) to Tavily', async () => {
    Tavily.search.mockResolvedValue({ results: [], images: [] });
    await HANDLERS.tavily_search({
      query: 'wga strike',
      max_results: 10,
      search_depth: 'basic',
      topic: 'news',
      time_range: 'week',
      include_domains: ['variety.com'],
      exclude_domains: ['reddit.com'],
    });
    expect(Tavily.search).toHaveBeenCalledTimes(1);
    const body = Tavily.search.mock.calls[0][0];
    expect(body).toMatchObject({
      query: 'wga strike',
      search_depth: 'basic',
      topic: 'news',
      max_results: 10,
      time_range: 'week',
      include_domains: ['variety.com'],
      exclude_domains: ['reddit.com'],
      include_answer: 'advanced',
      include_images: true,
      include_image_descriptions: true,
    });
  });

  it('clamps max_results to [1, 10] and defaults to advanced/general', async () => {
    Tavily.search.mockResolvedValue({ results: [], images: [] });
    await HANDLERS.tavily_search({ query: 'foo', max_results: 999 });
    let body = Tavily.search.mock.calls[0][0];
    expect(body.max_results).toBe(10);
    expect(body.search_depth).toBe('advanced');
    expect(body.topic).toBe('general');

    Tavily.search.mockClear();
    await HANDLERS.tavily_search({ query: 'foo', max_results: 0 });
    body = Tavily.search.mock.calls[0][0];
    expect(body.max_results).toBe(5);
  });

  it('handles plain-string image entries in the response', async () => {
    Tavily.search.mockResolvedValue({
      results: [],
      images: ['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg'],
    });
    const out = JSON.parse(await HANDLERS.tavily_search({ query: 'foo' }));
    expect(out.images).toEqual([
      { url: 'https://img.example.com/a.jpg' },
      { url: 'https://img.example.com/b.jpg' },
    ]);
  });

  it('returns a friendly error when the API key is missing', async () => {
    config.tavily.apiKey = null;
    const out = await HANDLERS.tavily_search({ query: 'foo' });
    expect(out).toMatch(/TAVILY_API_KEY is not configured/);
    expect(Tavily.search).not.toHaveBeenCalled();
  });

  it('rejects empty/whitespace queries without calling the API', async () => {
    const out = await HANDLERS.tavily_search({ query: '   ' });
    expect(out).toMatch(/non-empty query/);
    expect(Tavily.search).not.toHaveBeenCalled();
  });
});

describe('tavily_show_image', () => {
  it('returns the __IMAGE_PATH__ sentinel with caption', async () => {
    Tavily.fetchTavilyImageToTmp.mockResolvedValue({
      path: '/tmp/x.jpg',
      contentType: 'image/jpeg',
    });
    const out = await HANDLERS.tavily_show_image({
      url: 'https://img.example.com/x.jpg',
      caption: 'Naomi Klein at a 2024 talk',
    });
    expect(out).toBe('__IMAGE_PATH__:/tmp/x.jpg|Naomi Klein at a 2024 talk');
  });

  it('falls back to a default caption', async () => {
    Tavily.fetchTavilyImageToTmp.mockResolvedValue({
      path: '/tmp/y.jpg',
      contentType: 'image/jpeg',
    });
    const out = await HANDLERS.tavily_show_image({ url: 'https://img.example.com/y.jpg' });
    expect(out).toBe('__IMAGE_PATH__:/tmp/y.jpg|Web image.');
  });

  it('returns an error when url is missing', async () => {
    const out = await HANDLERS.tavily_show_image({});
    expect(out).toMatch(/requires a url/);
    expect(Tavily.fetchTavilyImageToTmp).not.toHaveBeenCalled();
  });
});
