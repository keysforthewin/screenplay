import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

const messagesCreate = vi.fn();
const countTokensMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: messagesCreate, countTokens: countTokensMock };
    }
  },
}));

vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

// listCharacters returns a fresh array each call so we can detect rebuilds
// (different array identity, even if contents look the same).
let listCharactersCalls = 0;
vi.mock('../src/mongo/characters.js', () => ({
  listCharacters: async () => {
    listCharactersCalls += 1;
    return [];
  },
}));
vi.mock('../src/mongo/prompts.js', () => ({
  getCharacterTemplate: async () => ({ fields: [] }),
  getPlotTemplate: async () => ({ synopsis_guidance: '', beat_guidance: '' }),
}));
vi.mock('../src/mongo/plots.js', () => ({
  getPlot: async () => ({ _id: 'main', beats: [] }),
}));
vi.mock('../src/mongo/directorNotes.js', () => ({
  getDirectorNotes: async () => ({ _id: 'director_notes', notes: [] }),
}));

vi.mock('../src/mongo/imageBytes.js', () => ({
  fetchImageFromUrl: async () => ({ buffer: Buffer.alloc(0), contentType: 'image/png' }),
  ALLOWED_IMAGE_TYPES: new Set(['image/png', 'image/jpeg', 'image/webp']),
}));

const { runAgent } = await import('../src/agent/loop.js');
const { TOOLS, CORE_TOOL_NAMES } = await import('../src/agent/tools.js');

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
  listCharactersCalls = 0;
});

describe('runAgent prompt-cache wiring', () => {
  it('marks cache_control on the last tool, both system blocks, and the last history block', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'ok' }],
    });

    const history = [
      { role: 'user', content: 'earlier prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'h1', name: 'list_beats', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'h1', content: '[]' },
        ],
      },
    ];

    await runAgent({
      history,
      userText: 'go',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const args = messagesCreate.mock.calls[0][0];

    // tools: lazy-loaded — first iteration sends only the core set.
    // Last entry still carries cache_control with 1h ttl.
    expect(Array.isArray(args.tools)).toBe(true);
    expect(args.tools).toHaveLength(CORE_TOOL_NAMES.size);
    const sentNames = args.tools.map((t) => t.name).sort();
    expect(sentNames).toEqual([...CORE_TOOL_NAMES].sort());
    const lastTool = args.tools[args.tools.length - 1];
    expect(lastTool.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // exported TOOLS array MUST remain pristine
    for (const t of TOOLS) expect(t.cache_control).toBeUndefined();

    // system: array of 2 text blocks, each with cache_control: ephemeral
    expect(Array.isArray(args.system)).toBe(true);
    expect(args.system).toHaveLength(2);
    for (const b of args.system) {
      expect(b.type).toBe('text');
      expect(typeof b.text).toBe('string');
      expect(b.cache_control).toEqual({ type: 'ephemeral' });
    }

    // messages: last message in history is the user-with-tool_result we passed,
    // and runAgent appends one more user msg (the new prompt) at the tail.
    // The cache breakpoint should land on the last message that has array
    // content — the appended user msg, on its last block (text).
    const msgs = args.messages;
    expect(msgs.length).toBeGreaterThan(0);
    const last = msgs[msgs.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const lastBlock = last.content[last.content.length - 1];
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('reuses the memoized system prompt across iterations when no mutating tool runs', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [{ type: 'tool_use', id: 't1', name: 'list_beats', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [{ type: 'tool_use', id: 't2', name: 'get_plot', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [{ type: 'text', text: 'done' }],
      });

    await runAgent({
      history: [],
      userText: 'go',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(messagesCreate).toHaveBeenCalledTimes(3);
    // listCharacters runs once for the initial buildSystem and once for the
    // omitDirectorNotes measurement at iter 0. No mutating tool fired, so the
    // system should NOT be rebuilt for iter 1 or 2.
    expect(listCharactersCalls).toBe(2);

    // Same system reference handed to every messages.create call.
    const sys0 = messagesCreate.mock.calls[0][0].system;
    const sys1 = messagesCreate.mock.calls[1][0].system;
    const sys2 = messagesCreate.mock.calls[2][0].system;
    expect(sys1).toBe(sys0);
    expect(sys2).toBe(sys0);
  });

  it('rebuilds the system prompt after a mutating tool runs', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [
          { type: 'tool_use', id: 't1', name: 'create_character', input: { name: 'X' } },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
        content: [{ type: 'text', text: 'done' }],
      });

    await runAgent({
      history: [],
      userText: 'add a char',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    // Initial buildSystem + omitDirectorNotes at iter 0 = 2.
    // Then create_character flips dirty, iter 1 rebuilds = 3.
    expect(listCharactersCalls).toBe(3);

    // Two API calls; system reference differs between them.
    const sys0 = messagesCreate.mock.calls[0][0].system;
    const sys1 = messagesCreate.mock.calls[1][0].system;
    expect(sys1).not.toBe(sys0);
  });
});
