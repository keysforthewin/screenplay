import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: messagesCreate };
    }
  },
}));

const { analyzeText } = await import('../src/llm/analyze.js');

beforeEach(() => {
  messagesCreate.mockReset();
});

describe('analyzeText', () => {
  it('passes system + user message to Anthropic and returns the joined text', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello world' }],
    });
    const out = await analyzeText({ system: 'sys', user: 'usr' });
    expect(out).toBe('Hello world');
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.system).toBe('sys');
    expect(arg.messages).toEqual([{ role: 'user', content: 'usr' }]);
    expect(arg.max_tokens).toBe(2048);
    expect(typeof arg.model).toBe('string');
    expect(arg.model.length).toBeGreaterThan(0);
  });

  it('respects custom model and maxTokens', async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    await analyzeText({ user: 'hi', model: 'custom-model', maxTokens: 100 });
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.model).toBe('custom-model');
    expect(arg.max_tokens).toBe(100);
  });

  it('concatenates multiple text blocks with newlines', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
    });
    const out = await analyzeText({ user: 'hi' });
    expect(out).toBe('Part 1\nPart 2');
  });

  it('ignores non-text content blocks', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'x', name: 'foo', input: {} },
        { type: 'text', text: 'kept' },
      ],
    });
    const out = await analyzeText({ user: 'hi' });
    expect(out).toBe('kept');
  });

  it('throws on empty user', async () => {
    await expect(analyzeText({ user: '' })).rejects.toThrow();
    await expect(analyzeText({})).rejects.toThrow();
    await expect(analyzeText({ user: '   ' })).rejects.toThrow();
  });

  it('omits system when not provided', async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    await analyzeText({ user: 'hi' });
    const arg = messagesCreate.mock.calls[0][0];
    expect(arg.system).toBeUndefined();
  });
});
