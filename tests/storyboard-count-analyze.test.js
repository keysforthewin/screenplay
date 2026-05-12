// Tests for analyzeStoryboardCount — the LLM-backed suggestion the "Analyze"
// button on the storyboard generation dialog calls. The function is one
// Anthropic tool_use call wrapped in error handling that collapses failures
// to { count: null, reason: '<reason>' }.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { analyzeStoryboardCount } = await import(
  '../src/llm/storyboardCountAnalyze.js'
);
const { _setAnthropicClientForTests, _resetAnthropicClientForTests } =
  await import('../src/anthropic/client.js');

function fakeClient({ count, reason } = {}, opts = {}) {
  const calls = [];
  const client = {
    messages: {
      create: vi.fn(async (args) => {
        calls.push(args);
        if (opts.noToolCall) {
          return { content: [{ type: 'text', text: 'nope' }] };
        }
        if (opts.throw) {
          throw new Error(opts.throw);
        }
        return {
          content: [
            {
              type: 'tool_use',
              name: 'suggest_count',
              input: { count, reason },
            },
          ],
        };
      }),
    },
  };
  return { client, calls };
}

beforeEach(() => {
  _resetAnthropicClientForTests();
});

const FAKE_BEAT = {
  order: 4,
  name: 'Diner reunion',
  desc: 'Alice meets Bob at the diner.',
  body: 'Alice arrives at the diner. She finds Bob in the back booth and sits down.',
};
const FAKE_CHARACTERS = [
  { name: 'Alice', fields: { role: 'protagonist' } },
  { name: 'Bob', fields: {} },
];

describe('analyzeStoryboardCount', () => {
  it('returns the suggested count and reason from the tool call', async () => {
    const { client, calls } = fakeClient({
      count: 8,
      reason: 'Short two-person beat; coverage + reactions fit in 8.',
    });
    _setAnthropicClientForTests(client);

    const result = await analyzeStoryboardCount({
      beat: FAKE_BEAT,
      characters: FAKE_CHARACTERS,
      direction: '',
    });
    expect(result.count).toBe(8);
    expect(result.reason).toMatch(/two-person beat/);
    // One LLM call with the suggest_count tool forced.
    expect(calls).toHaveLength(1);
    expect(calls[0].tool_choice).toEqual({ type: 'tool', name: 'suggest_count' });
  });

  it('clamps out-of-range values to [3, 30]', async () => {
    const { client } = fakeClient({ count: 100, reason: 'big' });
    _setAnthropicClientForTests(client);

    const result = await analyzeStoryboardCount({
      beat: FAKE_BEAT,
      characters: FAKE_CHARACTERS,
    });
    expect(result.count).toBe(30);
  });

  it('returns null count with reason="no_tool_call" when the model omits the tool call', async () => {
    const { client } = fakeClient({}, { noToolCall: true });
    _setAnthropicClientForTests(client);

    const result = await analyzeStoryboardCount({
      beat: FAKE_BEAT,
      characters: FAKE_CHARACTERS,
    });
    expect(result.count).toBe(null);
    expect(result.reason).toBe('no_tool_call');
  });

  it('returns null count with the error message when the SDK throws', async () => {
    const { client } = fakeClient({}, { throw: 'rate limited' });
    _setAnthropicClientForTests(client);

    const result = await analyzeStoryboardCount({
      beat: FAKE_BEAT,
      characters: FAKE_CHARACTERS,
    });
    expect(result.count).toBe(null);
    expect(result.reason).toMatch(/rate limited/);
  });

  it('includes the director direction in the user message when provided', async () => {
    const { client, calls } = fakeClient({ count: 6, reason: 'tight' });
    _setAnthropicClientForTests(client);

    await analyzeStoryboardCount({
      beat: FAKE_BEAT,
      characters: FAKE_CHARACTERS,
      direction: 'fast coverage, hold reactions long',
    });
    const userText = calls[0].messages[0].content[0].text;
    expect(userText).toMatch(/Director's direction/);
    expect(userText).toMatch(/fast coverage, hold reactions long/);
  });
});
