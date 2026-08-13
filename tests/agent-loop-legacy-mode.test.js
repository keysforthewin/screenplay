// Escape-hatch test: when ANTHROPIC_AGENT_MODEL === ANTHROPIC_MODEL, the loop
// reverts to single-model behavior — creative tools stay on the orchestrator,
// delegate_writing disappears.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

process.env.ANTHROPIC_MODEL = 'claude-fable-5';
process.env.ANTHROPIC_AGENT_MODEL = 'claude-fable-5';

const fakeDb = createFakeDb();

const messagesCreate = vi.fn();
const countTokensMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = {
        create: messagesCreate,
        stream: (args) => ({ finalMessage: () => messagesCreate(args) }),
        countTokens: countTokensMock,
      };
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
vi.mock('../src/mongo/sets.js', () => ({
  listSets: async () => [],
}));
vi.mock('../src/mongo/imageBytes.js', () => ({
  fetchImageFromUrl: async () => ({ buffer: Buffer.alloc(0), contentType: 'image/png' }),
  ALLOWED_IMAGE_TYPES: new Set(['image/png', 'image/jpeg', 'image/webp']),
}));

const { runAgent } = await import('../src/agent/loop.js');
const { LEGACY_CORE_TOOL_NAMES } = await import('../src/agent/tools.js');

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
});

describe('legacy single-model mode', () => {
  it('keeps edit/load_writing_context in core and hides delegate_writing', async () => {
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
    expect(args.model).toBe('claude-fable-5');
    const names = args.tools.map((t) => t.name);
    expect(names).toContain('edit');
    expect(names).toContain('load_writing_context');
    expect(names).not.toContain('delegate_writing');
    expect(names.sort()).toEqual([...LEGACY_CORE_TOOL_NAMES].sort());

    // Legacy prompt keeps the direct-edit workflow.
    const sysText = args.system.map((b) => b.text).join('\n');
    expect(sysText).toContain('load_writing_context');
    expect(sysText).not.toContain('delegate_writing');
  });

  it('tool_search can load writer-only tools but never delegate_writing', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'tool_search', input: { query: 'bulk update character field delegate writing', limit: 25 } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'done' }],
    });
    await runAgent({
      history: [],
      userText: 'fill in fields',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
    });

    const iter2Tools = messagesCreate.mock.calls[1][0].tools.map((t) => t.name);
    expect(iter2Tools).toContain('bulk_update_character_field');
    expect(iter2Tools).not.toContain('delegate_writing');
  });
});
