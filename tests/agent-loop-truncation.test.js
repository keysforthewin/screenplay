import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: messagesCreate };
    }
  },
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('../src/mongo/characters.js', () => ({
  listCharacters: async () => [],
}));
vi.mock('../src/mongo/prompts.js', () => ({
  getCharacterTemplate: async () => ({ fields: [] }),
  getPlotTemplate: async () => ({ fields: [] }),
}));
vi.mock('../src/mongo/plots.js', () => ({
  getPlot: async () => ({ _id: 'main', beats: [] }),
}));
vi.mock('../src/mongo/directorNotes.js', () => ({
  getDirectorNotes: async () => ({ _id: 'director_notes', notes: [] }),
}));

const { runAgent } = await import('../src/agent/loop.js');

beforeEach(() => {
  messagesCreate.mockReset();
});

describe('runAgent stop_reason guard', () => {
  it('strips orphan tool_use blocks when stop_reason is max_tokens', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [
        { type: 'text', text: 'Looking up beats…' },
        { type: 'tool_use', id: 'toolu_truncated', name: 'list_beats', input: {} },
      ],
    });

    const result = await runAgent({ history: [], userText: 'hi' });

    expect(result.text).toBe('Looking up beats…');
    expect(result.agentMessages).toHaveLength(1);
    const recorded = result.agentMessages[0];
    expect(recorded.role).toBe('assistant');
    const blockTypes = recorded.content.map((b) => b.type);
    expect(blockTypes).not.toContain('tool_use');
    expect(blockTypes).toContain('text');
  });

  it('falls back to a placeholder when content is only a truncated tool_use', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [
        { type: 'tool_use', id: 'toolu_only', name: 'list_beats', input: {} },
      ],
    });

    const result = await runAgent({ history: [], userText: 'hi' });

    const recorded = result.agentMessages[0];
    expect(recorded.role).toBe('assistant');
    expect(recorded.content).toEqual([
      { type: 'text', text: '(response truncated before completion)' },
    ]);
    expect(result.text).toBe('(response truncated before completion)');
  });

  it('preserves tool_use blocks when stop_reason IS tool_use (normal dispatch)', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_real', name: 'list_beats', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      });

    const result = await runAgent({ history: [], userText: 'hi' });

    expect(result.text).toBe('done');
    // First recorded turn is the assistant tool_use, second is the synthetic
    // tool_result we'd push (via dispatchToolUses → handler unknown → error
    // result), third is the final assistant text.
    expect(result.agentMessages[0].role).toBe('assistant');
    const firstTypes = result.agentMessages[0].content.map((b) => b.type);
    expect(firstTypes).toContain('tool_use');
    expect(result.agentMessages[1].role).toBe('user');
    expect(result.agentMessages[1].content[0].type).toBe('tool_result');
  });
});
