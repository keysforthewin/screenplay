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
  getCharacter: async () => null,
}));
vi.mock('../src/mongo/prompts.js', () => ({
  getCharacterTemplate: async () => ({ fields: [] }),
  getPlotTemplate: async () => ({ fields: [] }),
}));

const fakeBeat = { _id: 'abc', order: 2, name: 'Mid' };
vi.mock('../src/mongo/plots.js', () => ({
  getPlot: async () => ({ _id: 'main', beats: [fakeBeat] }),
  getBeat: async (identifier) => {
    if (identifier === '2' || identifier === 2 || identifier === 'Mid') return fakeBeat;
    return null;
  },
}));

vi.mock('../src/mongo/directorNotes.js', () => ({
  getDirectorNotes: async () => ({ _id: 'director_notes', notes: [] }),
}));

vi.mock('../src/agent/handlers.js', () => ({
  dispatchTool: async () => 'updated',
  HANDLERS: {},
}));

vi.mock('../src/mongo/tokenUsage.js', () => ({
  recordAnthropicTextUsage: async () => {},
  recordAnthropicImageInputUsage: async () => {},
}));

const { runAgent } = await import('../src/agent/loop.js');

beforeEach(() => {
  messagesCreate.mockReset();
});

describe('runAgent appends edit URLs for touched entities', () => {
  it('appends a /beat/<order> URL after update_beat even when the model text omits it', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Updating now…' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'update_beat',
            input: { identifier: '2', patch: { name: 'New' } },
          },
        ],
        usage: {},
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
        usage: {},
      });

    const result = await runAgent({ history: [], userText: 'rename beat 2' });
    expect(result.text).toMatch(/Done\./);
    expect(result.text).toMatch(/Edit in browser: http:\/\/localhost:3000\/beat\/2/);
  });

  it('does not double-print a URL the model already included', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'update_beat',
            input: { identifier: '2' },
          },
        ],
        usage: {},
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: 'Updated.\nEdit in browser: http://localhost:3000/beat/2',
          },
        ],
        usage: {},
      });

    const result = await runAgent({ history: [], userText: 'edit beat 2' });
    const matches = result.text.match(/http:\/\/localhost:3000\/beat\/2/g) || [];
    expect(matches).toHaveLength(1);
  });

  it('skips the append entirely when no entity-touching tools ran', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Hello there.' }],
      usage: {},
    });

    const result = await runAgent({ history: [], userText: 'hi' });
    expect(result.text).toBe('Hello there.');
    expect(result.text).not.toMatch(/Edit in browser/);
  });
});
