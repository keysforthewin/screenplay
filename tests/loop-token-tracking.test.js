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
vi.mock('../src/mongo/characters.js', () => ({ listCharacters: async () => [] }));
vi.mock('../src/mongo/prompts.js', () => ({
  getCharacterTemplate: async () => ({ fields: [] }),
  getPlotTemplate: async () => ({ fields: [] }),
}));
vi.mock('../src/mongo/plots.js', () => ({
  getPlot: async () => ({ _id: 'main', beats: [] }),
}));

// Image fetcher: hand-roll a fake PNG so image-size can read 300x300.
function makePngBuffer(width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(2, 17);
  ihdr.writeUInt8(0, 18);
  ihdr.writeUInt8(0, 19);
  ihdr.writeUInt8(0, 20);
  ihdr.writeUInt32BE(0, 21);
  return Buffer.concat([sig, ihdr]);
}

vi.mock('../src/mongo/imageBytes.js', () => ({
  fetchImageFromUrl: async () => ({ buffer: makePngBuffer(300, 300), contentType: 'image/png' }),
  ALLOWED_IMAGE_TYPES: new Set(['image/png', 'image/jpeg', 'image/webp']),
}));

const { runAgent } = await import('../src/agent/loop.js');

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  // Default: countTokens never invoked. Tests that care set their own behavior.
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
});

describe('runAgent records Anthropic token usage', () => {
  it('sums input/output across all 3 iterations of a tool-using turn', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 'u1', name: 'unknown_tool', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 200, output_tokens: 25 },
        content: [{ type: 'tool_use', id: 'u2', name: 'unknown_tool', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 40 },
        content: [{ type: 'text', text: 'all done' }],
      });

    const result = await runAgent({
      history: [],
      userText: 'hi',
      attachments: [],
      discordUser: { id: 'alice-id', displayName: 'Alice' },
      channelId: 'c1',
    });
    expect(result.text).toBe('all done');

    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    const text = docs[0];
    expect(text.kind).toBe('anthropic_text');
    expect(text.discord_user_id).toBe('alice-id');
    expect(text.discord_user_display_name).toBe('Alice');
    expect(text.meta.iteration_count).toBe(3);
    expect(text.meta.input_tokens).toBe(600); // sum across all 3 iterations
    expect(text.meta.output_tokens).toBe(85);
    expect(text.tokens).toBe(685); // input + output, no images
  });

  it('writes a separate anthropic_image_input doc when user attaches images', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 30 },
      content: [{ type: 'text', text: 'looked at the picture' }],
    });

    const attachments = [
      {
        url: 'http://example.com/a.png',
        filename: 'a.png',
        contentType: 'image/png',
        size: 1024,
        kind: 'image',
      },
    ];
    await runAgent({
      history: [],
      userText: 'see this',
      attachments,
      discordUser: { id: 'bob-id', displayName: 'Bob' },
      channelId: 'c1',
    });

    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(2);
    const text = docs.find((d) => d.kind === 'anthropic_text');
    const image = docs.find((d) => d.kind === 'anthropic_image_input');
    expect(image).toBeTruthy();
    // 300x300 → 120 image tokens.
    expect(image.tokens).toBe(120);
    expect(image.meta.image_count).toBe(1);
    // text input = 500 - 120 = 380, output = 30, tokens = 410
    expect(text.meta.input_tokens).toBe(380);
    expect(text.tokens).toBe(410);
  });

  it('records per-tool stats in meta.tools (count + result_tokens estimate)', async () => {
    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [
          { type: 'tool_use', id: 'a', name: 'fake_tool_alpha', input: {} },
          { type: 'tool_use', id: 'b', name: 'fake_tool_alpha', input: {} },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 150, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 'c', name: 'fake_tool_beta', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 30 },
        content: [{ type: 'text', text: 'done' }],
      });

    await runAgent({
      history: [],
      userText: 'go',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c',
    });

    const text = fakeDb
      .collection('token_usage')
      ._docs.find((d) => d.kind === 'anthropic_text');
    expect(text).toBeDefined();
    expect(text.meta.tools).toBeDefined();
    // dispatchTool returns "Unknown tool: <name>" for unregistered tools — same string each time.
    // "Unknown tool: fake_tool_alpha" = 29 chars → ceil(29/4) = 8 tokens; called twice → 16.
    expect(text.meta.tools.fake_tool_alpha).toEqual({ count: 2, result_tokens: 16 });
    // "Unknown tool: fake_tool_beta" = 28 chars → ceil(28/4) = 7 tokens; called once.
    expect(text.meta.tools.fake_tool_beta).toEqual({ count: 1, result_tokens: 7 });
  });

  it('still records usage when the loop hits MAX_TOOL_ITERATIONS', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'u', name: 'unknown_tool', input: {} }],
    });

    await runAgent({
      history: [],
      userText: 'loop forever',
      attachments: [],
      discordUser: { id: 'a', displayName: 'A' },
      channelId: 'c1',
    });

    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe('anthropic_text');
    expect(docs[0].meta.iteration_count).toBe(12);
    expect(docs[0].meta.input_tokens).toBe(120);
    expect(docs[0].meta.output_tokens).toBe(60);
  });
});

describe('runAgent records section_tokens budget snapshot', () => {
  it('measures sections only at iteration 1 and persists meta.section_tokens', async () => {
    // Sequence countTokens responses in the order calls are issued in
    // measureSectionTokens(): baseline, system, tools, user_input, history.
    // baseline=5, system=105 → sys=100, tools=205 → tools=200,
    // user=15 → user_input=10, history=305 → history=300.
    countTokensMock
      .mockResolvedValueOnce({ input_tokens: 5 }) // baseline
      .mockResolvedValueOnce({ input_tokens: 105 }) // system
      .mockResolvedValueOnce({ input_tokens: 205 }) // tools
      .mockResolvedValueOnce({ input_tokens: 15 }) // user_input
      .mockResolvedValueOnce({ input_tokens: 305 }); // history

    messagesCreate
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 'u1', name: 'unknown_tool', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 30 },
        content: [{ type: 'text', text: 'done' }],
      });

    await runAgent({
      history: [
        { role: 'user', content: 'earlier hi' },
        { role: 'assistant', content: 'earlier hi back' },
      ],
      userText: 'now',
      attachments: [],
      discordUser: { id: 'alice-id', displayName: 'Alice' },
      channelId: 'c1',
    });

    expect(countTokensMock).toHaveBeenCalledTimes(5);
    const doc = fakeDb
      .collection('token_usage')
      ._docs.find((d) => d.kind === 'anthropic_text');
    expect(doc).toBeDefined();
    expect(doc.meta.section_tokens).toEqual({
      system: 100,
      tools: 200,
      user_input: 10,
      message_history: 300,
    });
  });

  it('skips the history call and reports 0 history when there is no prior history', async () => {
    countTokensMock
      .mockResolvedValueOnce({ input_tokens: 5 }) // baseline
      .mockResolvedValueOnce({ input_tokens: 50 }) // system
      .mockResolvedValueOnce({ input_tokens: 80 }) // tools
      .mockResolvedValueOnce({ input_tokens: 12 }); // user_input
      // No history call: messages array has only the latest user msg

    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 10 },
      content: [{ type: 'text', text: 'ok' }],
    });

    await runAgent({
      history: [],
      userText: 'first ever',
      attachments: [],
      discordUser: { id: 'a', displayName: 'A' },
      channelId: 'c1',
    });

    expect(countTokensMock).toHaveBeenCalledTimes(4);
    const doc = fakeDb
      .collection('token_usage')
      ._docs.find((d) => d.kind === 'anthropic_text');
    expect(doc.meta.section_tokens).toEqual({
      system: 45,
      tools: 75,
      user_input: 7,
      message_history: 0,
    });
  });

  it('records usage without section_tokens when countTokens fails', async () => {
    countTokensMock.mockRejectedValue(new Error('count failed'));
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 50, output_tokens: 10 },
      content: [{ type: 'text', text: 'ok' }],
    });

    await runAgent({
      history: [],
      userText: 'hello',
      attachments: [],
      discordUser: { id: 'a', displayName: 'A' },
      channelId: 'c1',
    });

    const doc = fakeDb
      .collection('token_usage')
      ._docs.find((d) => d.kind === 'anthropic_text');
    expect(doc).toBeDefined();
    expect(doc.meta.section_tokens).toBeUndefined();
    expect(doc.meta.input_tokens).toBe(50);
  });
});
