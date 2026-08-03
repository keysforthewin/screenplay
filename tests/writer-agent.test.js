// Tests for the Fable 5 writer subagent (src/agent/writerAgent.js): the
// mini-loop that delegate_writing spawns. Uses the real handlers against fake
// Mongo, with the Anthropic client swapped via _setAnthropicClientForTests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

// Pin the two-tier model split before config.js is (transitively) imported —
// the developer's real .env may set these to anything.
process.env.ANTHROPIC_MODEL = 'claude-fable-5';
process.env.ANTHROPIC_AGENT_MODEL = 'claude-sonnet-5';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const streamMock = vi.fn();
const mockClient = {
  messages: {
    stream: (args) => ({ finalMessage: () => streamMock(args) }),
  },
};

const { config } = await import('../src/config.js');
const { createProject } = await import('../src/mongo/projects.js');
const Plots = await import('../src/mongo/plots.js');
const Characters = await import('../src/mongo/characters.js');
const { _setAnthropicClientForTests } = await import('../src/anthropic/client.js');
const { createTouchedEntities } = await import('../src/agent/entityLinks.js');
const { runWriterAgent } = await import('../src/agent/writerAgent.js');

let projectId;

beforeEach(async () => {
  fakeDb.reset();
  streamMock.mockReset();
  _setAnthropicClientForTests(mockClient);
  projectId = (await createProject('Test Project'))._id.toString();
});

function turnContext() {
  return {
    projectId,
    projectTitle: 'Test Project',
    discordUser: { id: 'u1', displayName: 'U' },
    channelId: 'c1',
    writingContextBeats: new Set(),
    touchedEntities: createTouchedEntities(),
  };
}

function endTurn(text) {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'text', text }],
  };
}

describe('runWriterAgent request shape', () => {
  it('calls Fable with the writer tool surface and the task as the seed message', async () => {
    streamMock.mockResolvedValueOnce(endTurn('- Updated beat'));

    const res = await runWriterAgent({ task: 'Tighten the pacing of beat 1.', context: turnContext() });

    expect(res).toEqual({ ok: true, text: '- Updated beat' });
    expect(streamMock).toHaveBeenCalledTimes(1);
    const args = streamMock.mock.calls[0][0];

    expect(args.model).toBe('claude-fable-5');
    expect(args.max_tokens).toBe(config.anthropic.writerMaxTokens);
    expect(args.thinking).toBeUndefined();

    const names = args.tools.map((t) => t.name);
    // Creative tools + writing gate + reads:
    for (const n of [
      'edit', 'load_writing_context', 'create_beat', 'create_character',
      'bulk_update_character_field', 'add_director_note',
      'add_film_dialogue_sample', 'update_character_template',
      'get_beat', 'read_beat_body', 'get_plot', 'list_characters',
    ]) {
      expect(names).toContain(n);
    }
    // No meta tools, no orchestrator-only tools:
    for (const n of ['tool_search', 'delegate_writing', 'generate_image', 'export_pdf', 'set_project']) {
      expect(names).not.toContain(n);
    }
    // Cache breakpoint on the last tool def.
    expect(args.tools[args.tools.length - 1].cache_control).toBeTruthy();

    // System: stable block cached, and the seed user message carries the task.
    expect(Array.isArray(args.system)).toBe(true);
    expect(args.system[0].cache_control).toBeTruthy();
    const seed = args.messages[0];
    expect(seed.role).toBe('user');
    const seedText = seed.content.map((b) => b.text).join('\n');
    expect(seedText).toContain('Tighten the pacing of beat 1.');
  });

  it('includes beat and character hints in the seed message when provided', async () => {
    streamMock.mockResolvedValueOnce(endTurn('- ok'));
    await runWriterAgent({
      task: 'Write the scene.',
      beat: '3',
      characters: ['Alice', 'Bob'],
      context: turnContext(),
    });
    const seedText = streamMock.mock.calls[0][0].messages[0].content
      .map((b) => b.text)
      .join('\n');
    expect(seedText).toMatch(/Target beat: 3/);
    expect(seedText).toMatch(/Alice, Bob/);
  });
});

describe('runWriterAgent tool dispatch', () => {
  it('runs load_writing_context then edit against Mongo and reports the final text', async () => {
    await Characters.createCharacter({ projectId, name: 'Alice', fields: { bio: 'Courier.' } });
    const beat = await Plots.createBeat({
      projectId, name: 'Standoff', desc: 'd', body: 'hello world', characters: ['Alice'],
    });
    const beatId = beat._id.toString();

    streamMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        { type: 'tool_use', id: 'w1', name: 'load_writing_context', input: { beat: beatId, characters: ['Alice'] } },
        { type: 'tool_use', id: 'w2', name: 'edit', input: { collection: 'beat', identifier: beatId, field: 'body', edits: [{ find: 'world', replace: 'mars' }] } },
      ],
    });
    streamMock.mockResolvedValueOnce(endTurn('- Edited Standoff body'));

    const events = [];
    const res = await runWriterAgent({
      task: 'Change world to mars.',
      context: turnContext(),
      onEvent: (e) => events.push(e),
    });

    expect(res.ok).toBe(true);
    expect(res.text).toBe('- Edited Standoff body');
    expect((await Plots.getBeat(projectId, beatId)).body).toBe('hello mars');

    // Tool results fed back on the second request, in order, non-error.
    const iter2Msgs = streamMock.mock.calls[1][0].messages;
    const resultMsg = iter2Msgs[iter2Msgs.length - 1];
    const ids = resultMsg.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
    expect(ids).toEqual(['w1', 'w2']);
    expect(resultMsg.content.every((b) => !b.is_error)).toBe(true);

    // Progress events surfaced through onEvent.
    expect(events.some((e) => e.type === 'tools' && e.tools.includes('edit'))).toBe(true);
  });

  it('surfaces the beat-body gate error to the model as is_error without mutating', async () => {
    const beat = await Plots.createBeat({ projectId, name: 'B', desc: 'd', body: 'hello world' });
    const beatId = beat._id.toString();

    streamMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        { type: 'tool_use', id: 'w1', name: 'edit', input: { collection: 'beat', identifier: beatId, field: 'body', edits: [{ find: 'world', replace: 'mars' }] } },
      ],
    });
    streamMock.mockResolvedValueOnce(endTurn('- Could not edit'));

    await runWriterAgent({ task: 'edit it', context: turnContext() });

    expect((await Plots.getBeat(projectId, beatId)).body).toBe('hello world');
    const iter2Msgs = streamMock.mock.calls[1][0].messages;
    const tr = iter2Msgs[iter2Msgs.length - 1].content.find((b) => b.type === 'tool_result');
    expect(tr.is_error).toBe(true);
    expect(tr.content).toMatch(/load_writing_context/);
  });

  it('records entity touches into context.touchedEntities', async () => {
    streamMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        { type: 'tool_use', id: 'w1', name: 'create_beat', input: { name: 'New Scene', desc: 'd' } },
      ],
    });
    streamMock.mockResolvedValueOnce(endTurn('- Created New Scene'));

    const ctx = turnContext();
    await runWriterAgent({ task: 'create a beat', context: ctx });

    expect(ctx.touchedEntities.beats.has('New Scene')).toBe(true);
  });
});

describe('runWriterAgent failure modes', () => {
  it('maps a refusal stop to ok:false with a Tool error message', async () => {
    streamMock.mockResolvedValueOnce({
      stop_reason: 'refusal',
      usage: { input_tokens: 10, output_tokens: 0 },
      content: [],
    });
    const res = await runWriterAgent({ task: 'x', context: turnContext() });
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/Tool error \(delegate_writing\)/);
  });

  it('maps a thrown API error to ok:false with a Tool error message', async () => {
    streamMock.mockRejectedValueOnce(new Error('boom'));
    const res = await runWriterAgent({ task: 'x', context: turnContext() });
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/Tool error \(delegate_writing\): boom/);
  });
});

describe('runWriterAgent usage recording', () => {
  it('records a token_usage doc with the writer model', async () => {
    streamMock.mockResolvedValueOnce(endTurn('- done'));
    await runWriterAgent({ task: 'x', context: turnContext() });

    const docs = await fakeDb.collection('token_usage').find({}).toArray();
    const writerDoc = docs.find((d) => d.kind === 'anthropic_text');
    expect(writerDoc).toBeTruthy();
    expect(writerDoc.model).toBe('claude-fable-5');
    expect(writerDoc.meta.iteration_count).toBe(1);
  });
});
