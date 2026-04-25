import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/tmdb/client.js', () => {
  const buildUrl = (p) =>
    p ? `https://image.tmdb.org/t/p/w500${p.startsWith('/') ? '' : '/'}${p}` : null;
  const isTmdbImageUrl = (url) => {
    try {
      return new URL(url).host === 'image.tmdb.org';
    } catch {
      return false;
    }
  };
  return {
    searchMovie: vi.fn(),
    getMovieDetails: vi.fn(),
    getMovieCredits: vi.fn(),
    searchPerson: vi.fn(),
    getPerson: vi.fn(),
    posterUrl: buildUrl,
    profileUrl: buildUrl,
    isTmdbImageUrl,
    fetchTmdbImageToTmp: vi.fn(),
  };
});

const { HANDLERS } = await import('../src/agent/handlers.js');
const Tmdb = await import('../src/tmdb/client.js');
const { config } = await import('../src/config.js');

beforeEach(() => {
  config.tmdb.readAccessToken = 'test-token';
  Tmdb.searchMovie.mockReset();
  Tmdb.getMovieDetails.mockReset();
  Tmdb.getMovieCredits.mockReset();
  Tmdb.searchPerson.mockReset();
  Tmdb.fetchTmdbImageToTmp.mockReset();
});

describe('tmdb_search_movie', () => {
  it('returns the top 5 movies with year and poster_url', async () => {
    Tmdb.searchMovie.mockResolvedValue({
      total_results: 12,
      results: Array.from({ length: 7 }).map((_, i) => ({
        id: 100 + i,
        title: `Movie ${i}`,
        release_date: '2020-05-01',
        overview: 'Long overview... '.repeat(50),
        poster_path: `/p${i}.jpg`,
      })),
    });
    const out = JSON.parse(await HANDLERS.tmdb_search_movie({ query: 'foo' }));
    expect(out.total_results).toBe(12);
    expect(out.results).toHaveLength(5);
    expect(out.results[0]).toMatchObject({
      id: 100,
      title: 'Movie 0',
      year: '2020',
      poster_url: 'https://image.tmdb.org/t/p/w500/p0.jpg',
    });
    expect(out.results[0].overview_preview.length).toBeLessThanOrEqual(200);
  });

  it('returns a friendly error when the token is missing', async () => {
    config.tmdb.readAccessToken = null;
    const out = await HANDLERS.tmdb_search_movie({ query: 'foo' });
    expect(out).toMatch(/TMDB_READ_ACCESS_TOKEN is not configured/);
    expect(Tmdb.searchMovie).not.toHaveBeenCalled();
  });
});

describe('tmdb_get_movie', () => {
  it('extracts director from crew and limits cast to 8', async () => {
    Tmdb.getMovieDetails.mockResolvedValue({
      id: 1,
      title: 'Test Movie',
      release_date: '1998-03-06',
      overview: 'A bowler walks into a bar.',
      runtime: 117,
      genres: [{ id: 1, name: 'Comedy' }],
      poster_path: '/poster.jpg',
      credits: {
        cast: Array.from({ length: 12 }).map((_, i) => ({
          id: 200 + i,
          name: `Actor ${i}`,
          character: `Char ${i}`,
          profile_path: `/a${i}.jpg`,
          order: i,
        })),
        crew: [
          { id: 1, name: 'Cinema P.', job: 'Director of Photography' },
          { id: 2, name: 'Joel Coen', job: 'Director' },
          { id: 3, name: 'Ethan Coen', job: 'Director' },
        ],
      },
    });
    const out = JSON.parse(await HANDLERS.tmdb_get_movie({ movie_id: 1 }));
    expect(out.title).toBe('Test Movie');
    expect(out.year).toBe('1998');
    expect(out.runtime_minutes).toBe(117);
    expect(out.director).toBe('Joel Coen');
    expect(out.genres).toEqual(['Comedy']);
    expect(out.top_cast).toHaveLength(8);
    expect(out.top_cast[0]).toMatchObject({
      character: 'Char 0',
      actor_name: 'Actor 0',
      person_id: 200,
      photo_url: 'https://image.tmdb.org/t/p/w500/a0.jpg',
    });
    expect(out.poster_url).toBe('https://image.tmdb.org/t/p/w500/poster.jpg');
  });

  it('handles a movie with no director and no poster gracefully', async () => {
    Tmdb.getMovieDetails.mockResolvedValue({
      id: 2,
      title: 'Anon',
      release_date: '',
      overview: '',
      runtime: null,
      genres: [],
      poster_path: null,
      credits: { cast: [], crew: [] },
    });
    const out = JSON.parse(await HANDLERS.tmdb_get_movie({ movie_id: 2 }));
    expect(out.director).toBeNull();
    expect(out.poster_url).toBeNull();
    expect(out.top_cast).toEqual([]);
    expect(out.year).toBeNull();
  });
});

describe('tmdb_get_movie_credits', () => {
  it('returns the full cast with photo_url and order', async () => {
    Tmdb.getMovieCredits.mockResolvedValue({
      cast: [
        { id: 1, name: 'Jeff Bridges', character: 'The Dude', profile_path: '/jb.jpg', order: 0 },
        { id: 2, name: 'John Goodman', character: 'Walter', profile_path: null, order: 1 },
      ],
    });
    const out = JSON.parse(await HANDLERS.tmdb_get_movie_credits({ movie_id: 1 }));
    expect(out.movie_id).toBe(1);
    expect(out.cast).toHaveLength(2);
    expect(out.cast[0]).toMatchObject({
      character: 'The Dude',
      actor_name: 'Jeff Bridges',
      person_id: 1,
      photo_url: 'https://image.tmdb.org/t/p/w500/jb.jpg',
      order: 0,
    });
    expect(out.cast[1].photo_url).toBeNull();
  });
});

describe('tmdb_search_person', () => {
  it('flattens known_for titles from both movies and tv', async () => {
    Tmdb.searchPerson.mockResolvedValue({
      total_results: 1,
      results: [
        {
          id: 1,
          name: 'Jeff Bridges',
          profile_path: '/jb.jpg',
          known_for: [
            { title: 'The Big Lebowski' },
            { name: 'A TV Show' },
            { title: 'Tron' },
          ],
        },
      ],
    });
    const out = JSON.parse(await HANDLERS.tmdb_search_person({ query: 'jeff' }));
    expect(out.results[0].known_for_titles).toEqual([
      'The Big Lebowski',
      'A TV Show',
      'Tron',
    ]);
    expect(out.results[0].photo_url).toBe('https://image.tmdb.org/t/p/w500/jb.jpg');
  });
});

describe('tmdb_show_image', () => {
  it('returns the __IMAGE_PATH__ prefix and caption on success', async () => {
    Tmdb.fetchTmdbImageToTmp.mockResolvedValue({
      path: '/tmp/x.jpg',
      contentType: 'image/jpeg',
    });
    const out = await HANDLERS.tmdb_show_image({
      url: 'https://image.tmdb.org/t/p/w500/x.jpg',
      caption: 'Jeff Bridges as The Dude',
    });
    expect(out).toBe('__IMAGE_PATH__:/tmp/x.jpg|Jeff Bridges as The Dude');
  });

  it('falls back to a default caption', async () => {
    Tmdb.fetchTmdbImageToTmp.mockResolvedValue({
      path: '/tmp/y.jpg',
      contentType: 'image/jpeg',
    });
    const out = await HANDLERS.tmdb_show_image({
      url: 'https://image.tmdb.org/t/p/w500/y.jpg',
    });
    expect(out).toBe('__IMAGE_PATH__:/tmp/y.jpg|TMDB image.');
  });

  it('rejects non-TMDB image URLs', async () => {
    const out = await HANDLERS.tmdb_show_image({ url: 'https://example.com/x.jpg' });
    expect(out).toMatch(/only accepts URLs on image\.tmdb\.org/);
    expect(Tmdb.fetchTmdbImageToTmp).not.toHaveBeenCalled();
  });

  it('returns a friendly error when the token is missing', async () => {
    config.tmdb.readAccessToken = null;
    const out = await HANDLERS.tmdb_show_image({
      url: 'https://image.tmdb.org/t/p/w500/x.jpg',
    });
    expect(out).toMatch(/TMDB_READ_ACCESS_TOKEN is not configured/);
    expect(Tmdb.fetchTmdbImageToTmp).not.toHaveBeenCalled();
  });
});
