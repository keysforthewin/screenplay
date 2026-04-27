import { describe, it, expect, vi, beforeEach } from 'vitest';

// Do NOT mock ../src/tmdb/client.js — we want to exercise the real findActorPortraitUrl.
const { findActorPortraitUrl } = await import('../src/tmdb/client.js');
const { config } = await import('../src/config.js');

beforeEach(() => {
  config.tmdb.readAccessToken = 'test-token';
  vi.restoreAllMocks();
});

describe('findActorPortraitUrl', () => {
  it('returns tmdb_not_configured when token is missing', async () => {
    config.tmdb.readAccessToken = null;
    const r = await findActorPortraitUrl('Anyone');
    expect(r).toEqual({ ok: false, reason: 'tmdb_not_configured' });
  });

  it('returns empty_name when actor name is blank', async () => {
    expect(await findActorPortraitUrl('')).toEqual({ ok: false, reason: 'empty_name' });
    expect(await findActorPortraitUrl('   ')).toEqual({ ok: false, reason: 'empty_name' });
    expect(await findActorPortraitUrl(null)).toEqual({ ok: false, reason: 'empty_name' });
  });

  it('returns ok with profile URL on hit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 7, name: 'Cillian Murphy', profile_path: '/cm.jpg' },
        ],
      }),
      text: async () => '',
    });
    const r = await findActorPortraitUrl('Cillian Murphy');
    expect(r).toEqual({
      ok: true,
      url: 'https://image.tmdb.org/t/p/w500/cm.jpg',
      tmdb_person_id: 7,
      person_name: 'Cillian Murphy',
    });
  });

  it('skips results that lack profile_path and returns no_match if all do', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 1, name: 'Top Hit', profile_path: null },
          { id: 2, name: 'Also', profile_path: undefined },
        ],
      }),
      text: async () => '',
    });
    const r = await findActorPortraitUrl('Anyone');
    expect(r).toEqual({ ok: false, reason: 'no_match' });
  });

  it('picks the first result with a profile_path even if not top-ranked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        results: [
          { id: 1, name: 'No Photo', profile_path: null },
          { id: 2, name: 'Has Photo', profile_path: '/hp.jpg' },
        ],
      }),
      text: async () => '',
    });
    const r = await findActorPortraitUrl('Whoever');
    expect(r.ok).toBe(true);
    expect(r.tmdb_person_id).toBe(2);
    expect(r.url).toBe('https://image.tmdb.org/t/p/w500/hp.jpg');
  });

  it('returns tmdb_error when the API throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => ({}),
      text: async () => 'boom',
    });
    const r = await findActorPortraitUrl('Anyone');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tmdb_error');
    expect(r.message).toMatch(/TMDB 500/);
  });
});
