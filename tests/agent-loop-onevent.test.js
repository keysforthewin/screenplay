// runAgent's optional progress hook (onEvent) and webRun context flag —
// added for the web chat surface; both must be invisible to the Discord path.
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

const dispatchToolMock = vi.hoisted(() => vi.fn(async () => 'ok'));
vi.mock('../src/agent/handlers.js', () => ({
  dispatchTool: dispatchToolMock,
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

function toolUseTurn(name = 'list_beats') {
  return {
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 10 },
    content: [{ type: 'tool_use', id: 't1', name, input: {} }],
  };
}

const baseArgs = () => ({
  history: [],
  userText: 'hello',
  attachments: [],
  discordUser: { id: 'u', displayName: 'U' },
  channelId: 'c1',
  projectId: PID,
  projectTitle: 'Proj',
});

beforeEach(() => {
  fakeDb.reset();
  messagesCreate.mockReset();
  countTokensMock.mockReset();
  countTokensMock.mockResolvedValue({ input_tokens: 0 });
  dispatchToolMock.mockReset();
  dispatchToolMock.mockResolvedValue('ok');
});

describe('runAgent onEvent hook', () => {
  it('emits iteration and tools events as the loop progresses', async () => {
    messagesCreate.mockResolvedValueOnce(toolUseTurn('list_beats'));
    messagesCreate.mockResolvedValueOnce(endTurn());

    const events = [];
    await runAgent({ ...baseArgs(), onEvent: (ev) => events.push(ev) });

    const iterations = events.filter((e) => e.type === 'iteration');
    expect(iterations.map((e) => e.n)).toEqual([1, 2]);
    const tools = events.filter((e) => e.type === 'tools' && e.tools.length);
    expect(tools).toEqual([{ type: 'tools', tools: ['list_beats'] }]);
  });

  it('a throwing onEvent listener does not break the run', async () => {
    messagesCreate.mockResolvedValueOnce(endTurn('still fine'));

    const result = await runAgent({
      ...baseArgs(),
      onEvent: () => {
        throw new Error('listener boom');
      },
    });
    expect(result.text).toBe('still fine');
  });

  it('webRun: true is threaded into the tool dispatch context', async () => {
    messagesCreate.mockResolvedValueOnce(toolUseTurn());
    messagesCreate.mockResolvedValueOnce(endTurn());

    await runAgent({ ...baseArgs(), webRun: true });

    const ctx = dispatchToolMock.mock.calls[0][2];
    expect(ctx.webRun).toBe(true);
  });

  it('defaults leave the Discord path untouched (webRun false, no events needed)', async () => {
    messagesCreate.mockResolvedValueOnce(toolUseTurn());
    messagesCreate.mockResolvedValueOnce(endTurn());

    const result = await runAgent(baseArgs());

    expect(result.text).toBe('done');
    const ctx = dispatchToolMock.mock.calls[0][2];
    expect(ctx.webRun).toBe(false);
  });
});
