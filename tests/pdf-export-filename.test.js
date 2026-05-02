import { describe, it, expect, vi, beforeEach } from 'vitest';

const analyzeTextMock = vi.fn();

vi.mock('../src/llm/analyze.js', () => ({
  analyzeText: (...args) => analyzeTextMock(...args),
}));

const { slugifyFilename, inferExportTitle } = await import('../src/pdf/export.js');

beforeEach(() => {
  analyzeTextMock.mockReset();
});

describe('slugifyFilename', () => {
  it('lowercases, replaces non-alnum with dashes, trims edges', () => {
    expect(slugifyFilename("Rae's Character Sheet")).toBe('rae-s-character-sheet');
    expect(slugifyFilename('  Full Script  ')).toBe('full-script');
    expect(slugifyFilename('Beats 1-10')).toBe('beats-1-10');
  });

  it('strips accents via NFKD normalization', () => {
    expect(slugifyFilename('Café Résumé')).toBe('cafe-resume');
  });

  it('collapses smart quotes / em dashes', () => {
    expect(slugifyFilename('Beats 1–10')).toBe('beats-1-10');
    expect(slugifyFilename('It’s Showtime')).toBe('it-s-showtime');
  });

  it('truncates at maxLen and re-trims trailing dashes', () => {
    const long = 'aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddddddd-eeeeeeeeee-ffffffffff-extra';
    const out = slugifyFilename(long, { maxLen: 60 });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('-')).toBe(false);
  });

  it('returns empty string for null / whitespace / non-Latin only', () => {
    expect(slugifyFilename(null)).toBe('');
    expect(slugifyFilename(undefined)).toBe('');
    expect(slugifyFilename('   ')).toBe('');
    expect(slugifyFilename('中村')).toBe('');
  });
});

describe('inferExportTitle', () => {
  it('returns slug derived from LLM output for dossier mode', async () => {
    analyzeTextMock.mockResolvedValueOnce("Rae's Character Sheet");
    const slug = await inferExportTitle({ mode: 'dossier', characterName: 'Rae' });
    expect(slug).toBe('rae-s-character-sheet');
  });

  it('preserves digits and hyphens for beats query', async () => {
    analyzeTextMock.mockResolvedValueOnce('Beats 1-10');
    const slug = await inferExportTitle({
      mode: 'beats',
      beatsQuery: 'opening',
      beatCount: 10,
    });
    expect(slug).toBe('beats-1-10');
  });

  it('caps slug length and trims trailing dashes', async () => {
    analyzeTextMock.mockResolvedValueOnce(
      'A Very Extremely Long Title That Goes On And On Without Any Concern For Brevity Whatsoever',
    );
    const slug = await inferExportTitle({ mode: 'full', characterCount: 3, beatCount: 4 });
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to mode-specific slug when LLM returns whitespace', async () => {
    analyzeTextMock.mockResolvedValueOnce('   ');
    expect(await inferExportTitle({ mode: 'dossier' })).toBe('dossier');
    analyzeTextMock.mockResolvedValueOnce('   ');
    expect(await inferExportTitle({ mode: 'character' })).toBe('character-sheet');
    analyzeTextMock.mockResolvedValueOnce('   ');
    expect(await inferExportTitle({ mode: 'characters' })).toBe('character-sheets');
    analyzeTextMock.mockResolvedValueOnce('   ');
    expect(await inferExportTitle({ mode: 'beats' })).toBe('beats');
    analyzeTextMock.mockResolvedValueOnce('   ');
    expect(await inferExportTitle({ mode: 'full' })).toBe('full-script');
  });

  it('falls back to mode-specific slug when slug becomes empty after stripping', async () => {
    analyzeTextMock.mockResolvedValueOnce('中村');
    const slug = await inferExportTitle({ mode: 'character', characterName: '中村' });
    expect(slug).toBe('character-sheet');
  });

  it('falls back when analyzeText throws', async () => {
    analyzeTextMock.mockRejectedValueOnce(new Error('network down'));
    const slug = await inferExportTitle({ mode: 'beats', beatsQuery: 'x', beatCount: 1 });
    expect(slug).toBe('beats');
  });

  it('falls back to generic export slug for unknown mode', async () => {
    analyzeTextMock.mockRejectedValueOnce(new Error('boom'));
    const slug = await inferExportTitle({ mode: 'unknown-mode' });
    expect(slug).toBe('export');
  });

  it('passes structured context to the LLM (mode, names, counts, date)', async () => {
    analyzeTextMock.mockResolvedValueOnce('Hero Trio Sheets');
    await inferExportTitle({
      mode: 'characters',
      characterNames: ['Alice', 'Bob', 'Steve'],
      title: 'Caper',
    });
    expect(analyzeTextMock).toHaveBeenCalledTimes(1);
    const args = analyzeTextMock.mock.calls[0][0];
    expect(args.system).toMatch(/screenwriting bot/);
    expect(args.user).toMatch(/Export mode: characters/);
    expect(args.user).toMatch(/Alice, Bob, Steve/);
    expect(args.user).toMatch(/Working title: "Caper"/);
    expect(args.user).toMatch(/Today is /);
    expect(args.model).toBe('claude-haiku-4-5');
  });
});
