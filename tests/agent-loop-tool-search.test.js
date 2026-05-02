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

vi.mock('../src/mongo/characters.js', () => ({
  listCharacters: async () => [],
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
const { CORE_TOOL_NAMES } = await import('../src/agent/tools.js');

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
});

describe('runAgent lazy tool loading via tool_search', () => {
  it('first iteration sends only the core tool set', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'ok' }],
    });
    await runAgent({
      history: [],
      userText: 'hi',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });
    const args = messagesCreate.mock.calls[0][0];
    expect(args.tools.length).toBe(CORE_TOOL_NAMES.size);
    const sentNames = args.tools.map((t) => t.name).sort();
    expect(sentNames).toEqual([...CORE_TOOL_NAMES].sort());
  });

  it('tool_search call expands the tools list on the next iteration', async () => {
    // Iteration 1: model calls tool_search("export pdf")
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'tool_search', input: { query: 'export pdf' } },
      ],
    });
    // Iteration 2: model returns text
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'done' }],
    });

    await runAgent({
      history: [],
      userText: 'export pdf',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(messagesCreate).toHaveBeenCalledTimes(2);

    const iter1Tools = messagesCreate.mock.calls[0][0].tools.map((t) => t.name);
    const iter2Tools = messagesCreate.mock.calls[1][0].tools.map((t) => t.name);

    // Iteration 1: only core
    expect(iter1Tools.sort()).toEqual([...CORE_TOOL_NAMES].sort());
    expect(iter1Tools).not.toContain('export_pdf');

    // Iteration 2: core + matched tools (export_pdf must be loaded)
    expect(iter2Tools).toContain('export_pdf');
    expect(iter2Tools.length).toBeGreaterThan(CORE_TOOL_NAMES.size);
    // Core still present
    for (const c of CORE_TOOL_NAMES) {
      expect(iter2Tools).toContain(c);
    }

    // The tool_result for tool_search must be present in iteration 2's messages
    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const toolResultMsg = iter2Msgs.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 't1'),
    );
    expect(toolResultMsg).toBeTruthy();
    const toolResultBlock = toolResultMsg.content.find((b) => b.type === 'tool_result');
    expect(toolResultBlock.content).toMatch(/export_pdf/);
  });

  it('tool_search and a real tool can fire in the same assistant response', async () => {
    // Model calls tool_search alongside list_beats (which is core, already loaded).
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'tool_search', input: { query: 'export pdf' } },
        { type: 'tool_use', id: 't2', name: 'list_beats', input: {} },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'done' }],
    });

    await runAgent({
      history: [],
      userText: 'show beats then export',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(messagesCreate).toHaveBeenCalledTimes(2);

    // Iter 2's messages should have tool_results for both t1 (meta) and t2 (real)
    // in the same user message, in the same order as the tool_uses.
    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const userMsgs = iter2Msgs.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result'),
    );
    expect(userMsgs.length).toBeGreaterThan(0);
    const lastWithResults = userMsgs[userMsgs.length - 1];
    const ids = lastWithResults.content
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id);
    expect(ids).toEqual(['t1', 't2']);

    // Iter 2 should have export_pdf loaded from the search.
    const iter2Tools = messagesCreate.mock.calls[1][0].tools.map((t) => t.name);
    expect(iter2Tools).toContain('export_pdf');
    expect(iter2Tools).toContain('list_beats');
  });

  it('empty-query / no-match tool_search returns a helpful message and adds no tools', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'tool_search', input: { query: 'xyzzy plugh quux gronk' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'done' }],
    });

    await runAgent({
      history: [],
      userText: 'do an obscure thing',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    const iter2Tools = messagesCreate.mock.calls[1][0].tools.map((t) => t.name);
    expect(iter2Tools.sort()).toEqual([...CORE_TOOL_NAMES].sort());

    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const last = iter2Msgs[iter2Msgs.length - 1];
    const trBlock = last.content.find((b) => b.type === 'tool_result' && b.tool_use_id === 't1');
    expect(trBlock).toBeTruthy();
    expect(trBlock.content).toMatch(/no tools matched/i);
  });

  it('multiple tool_search calls within a turn accumulate loaded tools', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'tool_search', input: { query: 'export pdf' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't2', name: 'tool_search', input: { query: 'generate image' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'done' }],
    });

    await runAgent({
      history: [],
      userText: 'do two things',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(messagesCreate).toHaveBeenCalledTimes(3);

    const iter3Tools = messagesCreate.mock.calls[2][0].tools.map((t) => t.name);
    expect(iter3Tools).toContain('export_pdf');
    expect(iter3Tools).toContain('generate_image');
  });
});
