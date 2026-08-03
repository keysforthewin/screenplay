// Tests for the two-tier orchestrator wiring in runAgent: Sonnet loop model,
// writer-only tools hidden, delegate_writing interception → runWriterAgent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

// Pin two-tier mode before config.js is (transitively) imported.
process.env.ANTHROPIC_MODEL = 'claude-fable-5';
process.env.ANTHROPIC_AGENT_MODEL = 'claude-sonnet-5';

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

const listCharactersMock = vi.fn(async () => []);
vi.mock('../src/mongo/characters.js', () => ({
  listCharacters: (...a) => listCharactersMock(...a),
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

const runWriterAgentMock = vi.fn();
vi.mock('../src/agent/writerAgent.js', () => ({
  runWriterAgent: (...a) => runWriterAgentMock(...a),
}));

const { runAgent } = await import('../src/agent/loop.js');
const { CORE_TOOL_NAMES } = await import('../src/agent/tools.js');

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  runWriterAgentMock.mockReset();
  listCharactersMock.mockClear();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
});

const baseRun = (over = {}) =>
  runAgent({
    history: [],
    userText: 'hi',
    attachments: [],
    discordUser: { id: 'u', displayName: 'U' },
    channelId: 'c1',
    ...over,
  });

describe('two-tier orchestrator surface', () => {
  it('runs the loop on the agent model with delegate_writing in core and no creative tools', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'ok' }],
    });
    await baseRun();

    const args = messagesCreate.mock.calls[0][0];
    expect(args.model).toBe('claude-sonnet-5');

    const names = args.tools.map((t) => t.name);
    expect(names).toContain('delegate_writing');
    expect(names).not.toContain('edit');
    expect(names).not.toContain('load_writing_context');
    expect(names.sort()).toEqual([...CORE_TOOL_NAMES].sort());

    // The system prompt teaches the delegation workflow, not direct editing.
    const sysText = args.system.map((b) => b.text).join('\n');
    expect(sysText).toContain('delegate_writing');
    expect(sysText).not.toContain('load_writing_context');
  });

  it('tool_search cannot load writer-only tools', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'tool_search', input: { query: 'edit rewrite beat body text update character', limit: 25 } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'done' }],
    });
    await baseRun();

    const iter2Tools = messagesCreate.mock.calls[1][0].tools.map((t) => t.name);
    for (const writerOnly of [
      'edit', 'load_writing_context', 'create_beat', 'create_character',
      'bulk_update_character_field', 'add_director_note',
      'add_film_dialogue_sample', 'update_character_template',
    ]) {
      expect(iter2Tools).not.toContain(writerOnly);
    }
  });
});

describe('delegate_writing interception', () => {
  it('invokes the writer and returns its report as the tool_result', async () => {
    runWriterAgentMock.mockResolvedValueOnce({ ok: true, text: '- Edited beat 1' });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 'd1', name: 'delegate_writing', input: { task: 'write the scene' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: '- Edited beat 1' }],
    });

    await baseRun({ projectId: 'p1', projectTitle: 'T' });

    expect(runWriterAgentMock).toHaveBeenCalledTimes(1);
    const callArg = runWriterAgentMock.mock.calls[0][0];
    expect(callArg.task).toBe('write the scene');
    expect(callArg.context).toMatchObject({ projectId: 'p1' });
    expect(callArg.context.touchedEntities).toBeTruthy();

    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const tr = iter2Msgs[iter2Msgs.length - 1].content.find(
      (b) => b.type === 'tool_result' && b.tool_use_id === 'd1',
    );
    expect(tr).toBeTruthy();
    expect(tr.content).toBe('- Edited beat 1');
    expect(tr.is_error).toBeUndefined();
  });

  it('marks the tool_result is_error when the writer fails', async () => {
    runWriterAgentMock.mockResolvedValueOnce({
      ok: false,
      text: 'Tool error (delegate_writing): writer refused the task',
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 'd1', name: 'delegate_writing', input: { task: 'x' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'sorry' }],
    });

    await baseRun();

    const iter2Msgs = messagesCreate.mock.calls[1][0].messages;
    const tr = iter2Msgs[iter2Msgs.length - 1].content.find((b) => b.type === 'tool_result');
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/Tool error \(delegate_writing\)/);
  });

  it('rebuilds the system prompt after a delegation (writer mutated state)', async () => {
    runWriterAgentMock.mockResolvedValueOnce({ ok: true, text: '- did it' });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 'd1', name: 'delegate_writing', input: { task: 'x' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'text', text: 'done' }],
    });

    await baseRun();

    // buildSystem calls listCharacters: initial build (1) + iteration-0
    // section-token variant (2) + post-delegation rebuild (3).
    expect(listCharactersMock).toHaveBeenCalledTimes(3);
  });
});
