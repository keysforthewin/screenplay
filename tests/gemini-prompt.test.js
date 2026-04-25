import { describe, it, expect } from 'vitest';
import { buildImagePrompt, summarizeRecentMessages } from '../src/gemini/promptBuilder.js';

describe('buildImagePrompt', () => {
  it('returns just the user prompt when only userPrompt is given', () => {
    const out = buildImagePrompt({ userPrompt: 'a cat in a top hat' });
    expect(out).toBe('a cat in a top hat');
  });

  it('includes scene context when beat is given', () => {
    const out = buildImagePrompt({
      beat: {
        name: 'Diner Morning',
        desc: 'Morning at the diner.',
        body: 'Sun streams through dusty windows.',
        characters: ['Alice', 'Bob'],
      },
    });
    expect(out).toContain('Scene name: Diner Morning');
    expect(out).toContain('Summary: Morning at the diner.');
    expect(out).toContain('Sun streams');
    expect(out).toContain('Alice, Bob');
  });

  it('combines all three input types', () => {
    const out = buildImagePrompt({
      userPrompt: 'film noir style',
      beat: { name: 'T', desc: 'D', body: 'B', characters: ['X'] },
      recentMessages: [{ role: 'user', content: 'looks moody' }],
    });
    expect(out).toContain('film noir style');
    expect(out).toContain('Scene name: T');
    expect(out).toContain('Recent conversation');
    expect(out).toContain('looks moody');
  });

  it('throws when no inputs are provided', () => {
    expect(() => buildImagePrompt({})).toThrow(/No prompt content/);
  });

  it('throws when only an empty userPrompt is given', () => {
    expect(() => buildImagePrompt({ userPrompt: '   ' })).toThrow();
  });

  it('handles array-content messages (Anthropic block format)', () => {
    const out = summarizeRecentMessages([
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'there' }] },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(out).toContain('user: hello there');
    expect(out).toContain('assistant: hi');
  });

  it('truncates long bodies', () => {
    const long = 'x'.repeat(2000);
    const out = buildImagePrompt({ beat: { name: 'T', desc: 'D', body: long, characters: [] } });
    expect(out.length).toBeLessThan(900);
    expect(out).toContain('…');
  });
});
