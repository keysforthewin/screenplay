import { describe, it, expect, beforeEach, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor() {
      this.messages = { create: createMock };
    }
  },
}));

const { AUDIO_TAGS, flattenAudioTags } = await import('../src/eleven/tags.js');
const { enhanceWithAudioTags, _internals } = await import('../src/eleven/enhance.js');

beforeEach(() => {
  createMock.mockReset();
});

describe('AUDIO_TAGS', () => {
  it('has the three groups with bracket-free tag names', () => {
    expect(Object.keys(AUDIO_TAGS)).toEqual(['Emotions', 'Delivery', 'Reactions']);
    for (const tags of Object.values(AUDIO_TAGS)) {
      expect(tags.length).toBeGreaterThan(5);
      for (const t of tags) expect(t).not.toMatch(/[[\]]/);
    }
    expect(AUDIO_TAGS.Reactions).toContain('laughs');
    expect(AUDIO_TAGS.Delivery).toContain('whispers');
    expect(AUDIO_TAGS.Emotions).toContain('sarcastic');
  });

  it('flattenAudioTags returns every tag once', () => {
    const flat = flattenAudioTags();
    expect(flat).toContain('laughs');
    expect(new Set(flat).size).toBe(flat.length);
  });
});

describe('enhanceWithAudioTags', () => {
  it('sends the text wrapped in data tags and returns the model text', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '[excited] Hello there! [laughs]' }],
    });
    const out = await enhanceWithAudioTags('Hello there!');
    expect(out).toBe('[excited] Hello there! [laughs]');
    const call = createMock.mock.calls[0][0];
    expect(call.messages[0].content).toContain('<text_to_annotate>');
    expect(call.messages[0].content).toContain('Hello there!');
    expect(call.system).toContain('[laughs]');
  });

  it('strips accidental wrapper tags from the response', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '<text_to_annotate>\n[sighs] Fine.\n</text_to_annotate>' }],
    });
    expect(await enhanceWithAudioTags('Fine.')).toBe('[sighs] Fine.');
  });

  it('rejects empty input without calling the API', async () => {
    await expect(enhanceWithAudioTags('   ')).rejects.toThrow('text required');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('surfaces API failure as a friendly error', async () => {
    createMock.mockRejectedValueOnce(new Error('overloaded'));
    await expect(enhanceWithAudioTags('hi')).rejects.toThrow(/Enhance failed: overloaded/);
  });

  it('the system prompt forbids rewriting words', () => {
    expect(_internals.SYSTEM_PROMPT).toMatch(/never .*(rewrite|add|remove|change).*(word)/i);
  });
});
