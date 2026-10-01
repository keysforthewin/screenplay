// Coding-agent harness provider: Messages-API ⇄ harness translation and the
// routing client in src/anthropic/client.js. Provider runners are faked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  buildHarnessTurn,
  mapHarnessAnswer,
  renderTranscript,
  requestMode,
} = await import('../src/llm/harness/translate.js');
const { harnessCreate, harnessStream, _setHarnessRunnersForTests, HarnessDisabledError } = await import(
  '../src/llm/harness/index.js'
);
const { createRoutingClient } = await import('../src/anthropic/client.js');
const { claudeEnv } = await import('../src/llm/harness/claudeCode.js');
const { codexEnv } = await import('../src/llm/harness/codex.js');

const TOOL = { name: 'populate_dialog', description: 'Write lines', input_schema: { type: 'object', properties: { entries: { type: 'array' } } } };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

beforeEach(() => {
  process.env.LLM_HARNESS_ENABLED = '1';
});
afterEach(() => {
  process.env.LLM_HARNESS_ENABLED = '';
  _setHarnessRunnersForTests(null);
});

describe('translate', () => {
  it('renders the conversation including tool calls, results and images', () => {
    const { text, images } = renderTranscript([
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', id: 't1', name: 'get_plot', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] },
    ]);
    expect(text).toContain('<user>\nhi\n\n[image 1 attached]');
    expect(text).toContain('[tool call t1] get_plot {"a":1}');
    expect(text).toContain('[tool result for t1 — ERROR]\nboom');
    expect(text).not.toContain('thinking');
    expect(images).toHaveLength(1);
  });

  it('picks the answer mode and schema from the request', () => {
    expect(requestMode({ messages: [], tools: [TOOL] })).toBe('tools');
    expect(requestMode({ messages: [], output_config: { format: { type: 'json_schema', schema: {} } } })).toBe('schema');
    expect(requestMode({ messages: [] })).toBe('text');
    const turn = buildHarnessTurn({ system: [{ type: 'text', text: 'SYS' }], messages: [{ role: 'user', content: 'go' }], tools: [TOOL] });
    expect(turn.schema.required).toEqual(['text', 'tool_calls']);
    expect(turn.prompt).toContain('### populate_dialog');
    expect(turn.prompt).toContain('SYS');
    expect(buildHarnessTurn({ system: 'SYS', messages: [] }, { includeSystem: false }).prompt).not.toContain('SYS');
  });

  it('maps a tool envelope to tool_use blocks', () => {
    const params = { messages: [], tools: [TOOL] };
    const out = mapHarnessAnswer(params, 'tools', { text: 'ok', tool_calls: [{ name: 'populate_dialog', input_json: '{"entries":[1]}' }] });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content[0]).toEqual({ type: 'text', text: 'ok' });
    expect(out.content[1]).toMatchObject({ type: 'tool_use', name: 'populate_dialog', input: { entries: [1] } });
    expect(out.content[1].id).toMatch(/^toolu_harness_/);
    expect(mapHarnessAnswer(params, 'tools', '{"text":"just talk","tool_calls":[]}').stop_reason).toBe('end_turn');
    expect(mapHarnessAnswer(params, 'tools', { text: '', tool_calls: [{ name: 'rm_rf', input_json: '{}' }] }).error).toMatch(/not one of/);
    expect(mapHarnessAnswer(params, 'tools', { text: '', tool_calls: [{ name: 'populate_dialog', input_json: 'nope' }] }).error).toMatch(/did not parse/);
  });

  it('returns schema answers as JSON text', () => {
    expect(mapHarnessAnswer({}, 'schema', { scores: [] }).content[0].text).toBe('{"scores":[]}');
    expect(mapHarnessAnswer({}, 'schema', '```json\n{"a":1}\n```').content[0].text).toBe('{"a":1}');
    expect(mapHarnessAnswer({}, 'schema', 'not json').error).toBeTruthy();
  });
});

describe('harnessCreate', () => {
  it('runs the provider named by the model id and returns an Anthropic message', async () => {
    const claude = vi.fn(async (turn) => {
      expect(turn.model).toBe('opus');
      expect(turn.effort).toBe('high');
      expect(turn.system).toBe('SYS');
      expect(turn.prompt).not.toContain('# Application system prompt'); // Claude takes it separately
      expect(turn.images).toHaveLength(1);
      expect(turn.images[0].mediaType).toBe('image/png');
      return { answer: { text: '', tool_calls: [{ name: 'populate_dialog', input_json: '{"entries":[]}' }] }, usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.02 } };
    });
    _setHarnessRunnersForTests({ 'claude-code': claude });
    const msg = await harnessCreate({
      model: 'claude-code:opus:high',
      system: 'SYS',
      tools: [TOOL],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: 'go' }] }],
    });
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.model).toBe('claude-code:opus:high');
    expect(msg.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, cost_usd: 0.02 });
  });

  it('inlines the system prompt for Codex and maps null model/effort to host defaults', async () => {
    const codex = vi.fn(async (turn) => {
      expect(turn.model).toBeNull();
      expect(turn.effort).toBeNull();
      expect(turn.prompt).toContain('# Application system prompt\n\nSYS');
      return { answer: 'hello', usage: {} };
    });
    _setHarnessRunnersForTests({ codex });
    const msg = await harnessCreate({ model: 'codex:default:default', system: 'SYS', messages: [{ role: 'user', content: 'hi' }] });
    expect(msg.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(msg.stop_reason).toBe('end_turn');
  });

  it('retries once with a correction when the answer does not map', async () => {
    const codex = vi.fn()
      .mockResolvedValueOnce({ answer: '{"text":"","tool_calls":[{"name":"nope","input_json":"{}"}]}', usage: { input_tokens: 1 } })
      .mockResolvedValueOnce({ answer: '{"text":"fine","tool_calls":[]}', usage: { input_tokens: 2 } });
    _setHarnessRunnersForTests({ codex });
    const msg = await harnessCreate({ model: 'codex:gpt-6-sol:high', tools: [TOOL], messages: [{ role: 'user', content: 'x' }] });
    expect(codex).toHaveBeenCalledTimes(2);
    expect(codex.mock.calls[1][0].prompt).toContain('# Correction');
    expect(msg.content).toEqual([{ type: 'text', text: 'fine' }]);
    expect(msg.usage.input_tokens).toBe(3);
  });

  it('refuses when the harness is disabled', async () => {
    process.env.LLM_HARNESS_ENABLED = '';
    await expect(harnessCreate({ model: 'codex:default:default', messages: [] })).rejects.toBeInstanceOf(HarnessDisabledError);
  });

  it('stream() emulates inputJson + finalMessage', async () => {
    _setHarnessRunnersForTests({
      codex: async () => ({ answer: { text: '', tool_calls: [{ name: 'populate_dialog', input_json: '{"entries":[1,2]}' }] }, usage: {} }),
    });
    const seen = [];
    const stream = harnessStream({ model: 'codex:default:low', tools: [TOOL], messages: [{ role: 'user', content: 'x' }] });
    stream.on('inputJson', (partial, snapshot) => seen.push([partial, snapshot]));
    const msg = await stream.finalMessage();
    expect(msg.stop_reason).toBe('tool_use');
    expect(seen).toEqual([['{"entries":[1,2]}', { entries: [1, 2] }]]);
  });
});

describe('routing client', () => {
  it('sends API ids to the SDK and harness ids to the adapter', async () => {
    const base = {
      models: { list: vi.fn() },
      messages: {
        create: vi.fn(async () => ({ via: 'api' })),
        stream: vi.fn(() => ({ via: 'api-stream' })),
        countTokens: vi.fn(async () => ({ input_tokens: 7 })),
      },
    };
    _setHarnessRunnersForTests({ codex: async () => ({ answer: 'harness', usage: {} }) });
    const client = createRoutingClient(base);
    expect(await client.messages.create({ model: 'claude-fable-5-1', messages: [] })).toEqual({ via: 'api' });
    expect(client.messages.stream({ model: 'claude-fable-5-1', messages: [] })).toEqual({ via: 'api-stream' });
    expect(await client.messages.countTokens({ model: 'claude-fable-5-1', messages: [] })).toEqual({ input_tokens: 7 });
    const msg = await client.messages.create({ model: 'codex:default:default', messages: [{ role: 'user', content: 'x' }] });
    expect(msg.content[0].text).toBe('harness');
    await expect(client.messages.countTokens({ model: 'codex:default:default', messages: [] })).rejects.toThrow(/token counting/);
    expect(base.messages.create).toHaveBeenCalledTimes(1);
    expect(client.models).toBe(base.models);
  });
});

describe('child environments', () => {
  it('strip API keys so the harness uses the mounted login', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oa', HOME: '/home/x' };
    expect(claudeEnv(env)).toEqual({ OPENAI_API_KEY: 'sk-oa', HOME: '/home/x' });
    expect(codexEnv(env)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant', HOME: '/home/x' });
  });
});
