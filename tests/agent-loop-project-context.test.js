import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

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
vi.mock('../src/mongo/imageBytes.js', () => ({
  fetchImageFromUrl: async () => ({ buffer: Buffer.alloc(0), contentType: 'image/png' }),
  ALLOWED_IMAGE_TYPES: new Set(['image/png', 'image/jpeg', 'image/webp']),
}));

const dispatchToolMock = vi.hoisted(() => vi.fn(async () => 'ok'));
vi.mock('../src/agent/handlers.js', () => ({
  dispatchTool: dispatchToolMock,
}));

const entitySpies = vi.hoisted(() => ({ clearTouchedEntities: vi.fn() }));
vi.mock('../src/agent/entityLinks.js', async (importOriginal) => ({
  ...(await importOriginal()),
  clearTouchedEntities: entitySpies.clearTouchedEntities,
}));

const { runAgent } = await import('../src/agent/loop.js');

const PID = 'a1b2c3d4e5f6a1b2c3d4e5f6';

function endTurn(text = 'done') {
  return {
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 10 },
    content: [{ type: 'text', text }],
  };
}

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
  dispatchToolMock.mockReset();
  dispatchToolMock.mockResolvedValue('ok');
  entitySpies.clearTouchedEntities.mockReset();
});

describe('runAgent project context', () => {
  it('passes projectId/projectTitle/channelId to dispatched tool handlers', async () => {
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 't1', name: 'list_beats', input: {} }],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'list beats',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'My Movie',
    });

    expect(dispatchToolMock).toHaveBeenCalledWith(
      'list_beats',
      {},
      expect.objectContaining({ channelId: 'c1', projectId: PID, projectTitle: 'My Movie' }),
    );
  });

  it('returns the final projectId in the result', async () => {
    messagesCreate.mockResolvedValueOnce(endTurn());
    const result = await runAgent({
      history: [],
      userText: 'hi',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'My Movie',
    });
    expect(result.projectId).toBe(PID);
  });

  it('names the current project in the volatile system block', async () => {
    messagesCreate.mockResolvedValueOnce(endTurn());
    await runAgent({
      history: [],
      userText: 'hi',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'My Movie',
    });
    const system = messagesCreate.mock.calls[0][0].system;
    const joined = system.map((b) => b.text || '').join('\n');
    expect(joined).toContain('Current project: "My Movie"');
  });

  it('a successful set_project clears pre-switch touched entities, and the update_beat touch is gone', async () => {
    const PID_B = 'b'.repeat(24);
    // Capture what touchedEntities looks like at clear-time so we can assert
    // the pre-switch beat ref is present and will be dropped.
    let capturedAtClear = null;
    entitySpies.clearTouchedEntities.mockImplementation((touched) => {
      capturedAtClear = {
        beats: new Set(touched.beats),
        characters: new Set(touched.characters),
        notes: touched.notes,
      };
      // Actually clear so post-switch touches are not contaminated.
      touched.beats.clear();
      touched.characters.clear();
      touched.notes = false;
    });

    dispatchToolMock.mockImplementation(async (name, _input, context) => {
      if (name === 'set_project') {
        // Real handler (Task 13) mutates context in place on success.
        context.projectId = PID_B;
        context.projectTitle = 'B';
        return 'Switched to project "B".';
      }
      return 'ok';
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'update_beat', input: { identifier: '5' } },
        { type: 'tool_use', id: 't2', name: 'set_project', input: { title: 'B' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'switch',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'A',
    });

    // The clear must have fired exactly once.
    expect(entitySpies.clearTouchedEntities).toHaveBeenCalledTimes(1);
    // At the moment of clearing, the pre-switch beat touch was present.
    expect(capturedAtClear).not.toBeNull();
    expect(capturedAtClear.beats.has('5')).toBe(true);
  });

  it('a failed set_project does NOT clear touched entities', async () => {
    dispatchToolMock.mockImplementation(async (name) =>
      name === 'set_project'
        ? 'Tool error (set_project): no project titled "B". Available projects: "A".'
        : 'ok',
    );
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 't1', name: 'set_project', input: { title: 'B' } }],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'switch',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'A',
    });

    expect(entitySpies.clearTouchedEntities).not.toHaveBeenCalled();
  });

  it('set_project returning a friendly-error string (no context mutation) does NOT clear touches', async () => {
    // Simulates the Task-13 handler finding no matching project and returning
    // a user-visible error string without mutating context.projectId. The old
    // is_error-based check was fragile here because dispatchToolUses tags
    // "Tool error (" strings with is_error:true — but a handler could also
    // return a non-prefixed friendly error string that is NOT tagged is_error
    // while still leaving context unchanged. The new mutation-keyed check
    // handles both cases correctly.
    dispatchToolMock.mockImplementation(async (name) => {
      if (name === 'set_project') {
        // Friendly error string, NOT prefixed with "Tool error (" — would NOT
        // be tagged is_error by dispatchToolUses, yet context is unchanged.
        return 'No project found with that name. Did you mean "Alpha"?';
      }
      return 'ok';
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [
        { type: 'tool_use', id: 't1', name: 'update_beat', input: { identifier: '3' } },
        { type: 'tool_use', id: 't2', name: 'set_project', input: { title: 'Typo' } },
      ],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'switch',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'Alpha',
    });

    // No context mutation → no clear, pre-switch touches are preserved.
    expect(entitySpies.clearTouchedEntities).not.toHaveBeenCalled();
  });

  it('rebuilds the system prompt for the NEW project on the iteration after a successful set_project', async () => {
    const PID_B = 'b'.repeat(24);
    dispatchToolMock.mockImplementation(async (name, _input, context) => {
      if (name === 'set_project') {
        // Mirrors the real handler (Task 13): mutates the shared context in place.
        context.projectId = PID_B;
        context.projectTitle = 'New Movie';
        return 'Switched to project "New Movie".';
      }
      return 'ok';
    });
    messagesCreate.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 't1', name: 'set_project', input: { title: 'New Movie' } }],
    });
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({
      history: [],
      userText: 'switch',
      attachments: [],
      discordUser: { id: 'u', displayName: 'U' },
      channelId: 'c1',
      projectId: PID,
      projectTitle: 'Old Movie',
    });

    // set_project starts with 'set_' (MUTATING_PREFIXES) → systemDirty flips →
    // the loop rebuilds the system from context.projectId/projectTitle at the
    // top of the next iteration, BEFORE the second messages.create call.
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    const joinSystem = (call) => call[0].system.map((b) => b.text || '').join('\n');
    expect(joinSystem(messagesCreate.mock.calls[0])).toContain('Current project: "Old Movie"');
    expect(joinSystem(messagesCreate.mock.calls[1])).toContain('Current project: "New Movie"');
  });
});
