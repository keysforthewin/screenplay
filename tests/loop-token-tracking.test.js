import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

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
