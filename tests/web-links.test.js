import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadLinks() {
  return await import('../src/web/links.js');
}

describe('characterUrl', () => {
  it('builds a URL from a plain name', async () => {
    const { characterUrl } = await loadLinks();
    expect(characterUrl({ name: 'Steve' })).toBe('http://localhost:3000/character/Steve');
  });

  it('strips markdown from the name', async () => {
    const { characterUrl } = await loadLinks();
    expect(characterUrl({ name: '**Steve**' })).toBe('http://localhost:3000/character/Steve');
  });

  it('URL-encodes spaces and special chars', async () => {
    const { characterUrl } = await loadLinks();
    expect(characterUrl({ name: 'Anne Hathaway' })).toBe(
      'http://localhost:3000/character/Anne%20Hathaway',
    );
    expect(characterUrl({ name: 'Renée Z.' })).toBe(
      `http://localhost:3000/character/${encodeURIComponent('Renée Z.')}`,
    );
  });

  it('returns null for missing or empty names', async () => {
    const { characterUrl } = await loadLinks();
    expect(characterUrl(null)).toBeNull();
    expect(characterUrl(undefined)).toBeNull();
    expect(characterUrl({})).toBeNull();
    expect(characterUrl({ name: '' })).toBeNull();
    expect(characterUrl({ name: '   ' })).toBeNull();
    expect(characterUrl({ name: '**  **' })).toBeNull();
  });
});

describe('beatUrl', () => {
  it('builds a URL from numeric order', async () => {
    const { beatUrl } = await loadLinks();
    expect(beatUrl({ order: 3 })).toBe('http://localhost:3000/beat/3');
  });

  it('accepts order=0 as valid', async () => {
    const { beatUrl } = await loadLinks();
    expect(beatUrl({ order: 0 })).toBe('http://localhost:3000/beat/0');
  });

  it('returns null when order is missing or not a number', async () => {
    const { beatUrl } = await loadLinks();
    expect(beatUrl(null)).toBeNull();
    expect(beatUrl(undefined)).toBeNull();
    expect(beatUrl({})).toBeNull();
    expect(beatUrl({ order: '3' })).toBeNull();
    expect(beatUrl({ order: NaN })).toBeNull();
  });
});

describe('notesUrl', () => {
  it('returns the shared notes URL', async () => {
    const { notesUrl } = await loadLinks();
    expect(notesUrl()).toBe('http://localhost:3000/notes');
  });
});

describe('withSpaLink', () => {
  it('returns text unchanged when url is null', async () => {
    const { withSpaLink } = await loadLinks();
    expect(withSpaLink('hello', null)).toBe('hello');
    expect(withSpaLink('hello', undefined)).toBe('hello');
    expect(withSpaLink('hello', '')).toBe('hello');
  });

  it('appends an Edit in browser line on its own line', async () => {
    const { withSpaLink } = await loadLinks();
    expect(withSpaLink('hello', 'http://x/y')).toBe('hello\nEdit in browser: http://x/y');
  });

  it('trims trailing whitespace before appending', async () => {
    const { withSpaLink } = await loadLinks();
    expect(withSpaLink('hello\n', 'http://x/y')).toBe('hello\nEdit in browser: http://x/y');
    expect(withSpaLink('hello   \n\n', 'http://x/y')).toBe(
      'hello\nEdit in browser: http://x/y',
    );
  });
});

describe('with WEB_PUBLIC_BASE_URL set', () => {
  const origBase = process.env.WEB_PUBLIC_BASE_URL;

  beforeEach(() => {
    process.env.WEB_PUBLIC_BASE_URL = 'https://app.example.com/';
    vi.resetModules();
  });

  afterEach(() => {
    if (origBase === undefined) delete process.env.WEB_PUBLIC_BASE_URL;
    else process.env.WEB_PUBLIC_BASE_URL = origBase;
    vi.resetModules();
  });

  it('uses the configured base and trims trailing slash', async () => {
    const { characterUrl, beatUrl, notesUrl } = await loadLinks();
    expect(characterUrl({ name: 'Steve' })).toBe('https://app.example.com/character/Steve');
    expect(beatUrl({ order: 2 })).toBe('https://app.example.com/beat/2');
    expect(notesUrl()).toBe('https://app.example.com/notes');
  });
});
