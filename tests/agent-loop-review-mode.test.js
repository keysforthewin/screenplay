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

// Mock the handler dispatcher so we can assert which tools actually ran.
const dispatchToolMock = vi.fn();
vi.mock('../src/agent/handlers.js', () => ({
  dispatchTool: (...args) => dispatchToolMock(...args),
  HANDLERS: {},
}));

const { runAgent } = await import('../src/agent/loop.js');

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
  dispatchToolMock.mockReset();
  // Default: handlers return a benign string so the loop can keep going.
  dispatchToolMock.mockImplementation(async (name) => `(mocked result for ${name})`);
});

function findToolResult(messages, toolUseId) {
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.tool_use_id === toolUseId) return b;
    }
  }
  return null;
}

describe('runAgent review-mode', () => {
  it('intercepts a mutating tool call when userText signals review intent', async () => {
    // Iter 1: model calls set_beat_body (mutation).
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'set_beat_body',
          input: { beat: 'beat26', body: 'new body' },
        },
      ],
    });
    // Iter 2: model produces the plan reply.
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        {
          type: 'text',
          text: '## Proposed plan\nBefore: …\nAfter: …\n\nNo changes will be made until you confirm.',
        },
      ],
    });

    const result = await runAgent({
      history: [],
      userText: 'context analyze and create impact gravitas for the body of beat26 and let me review',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    // Handler must NOT have been called for the blocked mutation.
    expect(dispatchToolMock).not.toHaveBeenCalledWith(
      'set_beat_body',
      expect.anything(),
      expect.anything(),
    );
    expect(dispatchToolMock).not.toHaveBeenCalled();

    // Iter 2's messages must contain the intercept payload as a tool_result for t1.
    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const tr = findToolResult(iter2Msgs, 't1');
    expect(tr).toBeTruthy();
    expect(tr.content).toMatch(/Review mode is active/);
    expect(tr.content).toContain('`set_beat_body`');
    expect(tr.content).toMatch(/NOT executed/);

    // Final reply text contains the plan disclosure.
    expect(result.text).toMatch(/No changes will be made until you confirm/);
  });

  it('blocks revise_character (now caught by the revise_ prefix)', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        {
          type: 'tool_use',
          id: 'r1',
          name: 'revise_character',
          input: { identifier: 'Alice', instructions: 'tighten' },
        },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'plan with no changes will be made until you confirm.' }],
    });

    await runAgent({
      history: [],
      userText: 'rewrite Alice but let me review first',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(dispatchToolMock).not.toHaveBeenCalled();
    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const tr = findToolResult(iter2Msgs, 'r1');
    expect(tr.content).toContain('`revise_character`');
  });

  it('lets read-only tool calls flow through under review-mode', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 'g1', name: 'get_beat', input: { beat: 'beat26' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'plan: No changes will be made until you confirm.' }],
    });

    await runAgent({
      history: [],
      userText: 'let me review beat 26',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    // Read-only tools dispatch normally even in review-mode.
    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    expect(dispatchToolMock).toHaveBeenCalledWith(
      'get_beat',
      expect.objectContaining({ beat: 'beat26' }),
      expect.anything(),
    );
  });

  it('blocks every mutation when several fire in one assistant turn', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 'm1', name: 'set_beat_body', input: { beat: 'b1', body: 'x' } },
        {
          type: 'tool_use',
          id: 'm2',
          name: 'update_character',
          input: { identifier: 'Alice', patch: { name: 'Alicia' } },
        },
        { type: 'tool_use', id: 'r1', name: 'get_beat', input: { beat: 'b1' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'plan — No changes will be made until you confirm.' }],
    });

    await runAgent({
      history: [],
      userText: 'revise these for my review',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    // Only the read-only tool got dispatched.
    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    expect(dispatchToolMock).toHaveBeenCalledWith('get_beat', expect.anything(), expect.anything());

    // Iter 2 must contain a tool_result for EACH original tool_use id, in order.
    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const lastUser = iter2Msgs[iter2Msgs.length - 1];
    expect(lastUser.role).toBe('user');
    const ids = lastUser.content
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id);
    expect(ids).toEqual(['m1', 'm2', 'r1']);

    const m1 = lastUser.content.find((b) => b.tool_use_id === 'm1');
    const m2 = lastUser.content.find((b) => b.tool_use_id === 'm2');
    expect(m1.content).toContain('`set_beat_body`');
    expect(m2.content).toContain('`update_character`');
  });

  it('lets tool_search flow through under review-mode (the model needs it to plan)', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        {
          type: 'tool_use',
          id: 's1',
          name: 'tool_search',
          input: { query: 'edit beat body' },
        },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'plan — No changes will be made until you confirm.' }],
    });

    await runAgent({
      history: [],
      userText: 'before you edit, draft a plan',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    // tool_search is meta — still handled inline; no handler dispatch.
    expect(dispatchToolMock).not.toHaveBeenCalled();

    // The next iteration's tools list expanded with at least one match.
    const iter1Tools = messagesCreate.mock.calls[0][0].tools.map((t) => t.name);
    const iter2Tools = messagesCreate.mock.calls[1][0].tools.map((t) => t.name);
    expect(iter2Tools.length).toBeGreaterThan(iter1Tools.length);
  });

  it('confirmation turn ("do it") with no review signal dispatches mutations normally', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        {
          type: 'tool_use',
          id: 'a1',
          name: 'set_beat_body',
          input: { beat: 'beat26', body: 'new' },
        },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: '- Updated beat 26 body' }],
    });

    await runAgent({
      history: [
        // Prior turn produced a plan.
        {
          role: 'user',
          content: 'context analyze and create impact gravitas for beat 26 and let me review',
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '## Proposed plan\n…\nNo changes will be made until you confirm.' },
          ],
        },
      ],
      userText: 'do it',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    expect(dispatchToolMock).toHaveBeenCalledWith(
      'set_beat_body',
      expect.objectContaining({ beat: 'beat26' }),
      expect.anything(),
    );
  });

  it('"review and apply" override suppresses review-mode and dispatches normally', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        {
          type: 'tool_use',
          id: 'x1',
          name: 'set_beat_body',
          input: { beat: 'b1', body: 'x' },
        },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: '- Updated beat body' }],
    });

    await runAgent({
      history: [],
      userText: 'review and apply the changes to beat 1',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    expect(dispatchToolMock).toHaveBeenCalledTimes(1);
    expect(dispatchToolMock).toHaveBeenCalledWith(
      'set_beat_body',
      expect.anything(),
      expect.anything(),
    );
  });

  it('appends the review-mode suffix as an unmarked third system block', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'plan' }],
    });

    await runAgent({
      history: [],
      userText: 'let me review the changes',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    const sys = messagesCreate.mock.calls[0][0].system;
    expect(sys).toHaveLength(3);
    // First two blocks (stable, volatile) carry cache_control; third does not.
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[2].cache_control).toBeUndefined();
    expect(sys[2].text).toMatch(/Review-mode/);
    expect(sys[2].text).toMatch(/No changes will be made until you confirm/);
  });

  it('does NOT append the review-mode suffix when no review intent', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'ok' }],
    });

    await runAgent({
      history: [],
      userText: 'add a line to beat 26',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    const sys = messagesCreate.mock.calls[0][0].system;
    expect(sys).toHaveLength(2);
  });
});
