import { describe, it, expect, vi, beforeEach } from 'vitest';

const messagesCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: messagesCreate };
    }
  },
}));

const warnSpy = vi.fn();
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: warnSpy, debug: () => {}, error: () => {} },
}));

let hasKey = true;
vi.mock('../src/config.js', () => ({
  config: {
    get anthropic() {
      return {
        apiKey: hasKey ? 'test-key' : null,
        enhancerModel: 'claude-haiku-4-5-20251001',
        model: 'claude-opus-4-7',
      };
    },
  },
}));

const { _resetAnthropicClientForTests } = await import('../src/anthropic/client.js');
const { selectFrameReferences } = await import('../src/llm/frameReferenceSelector.js');

const CANDS = [
  { id: 'art1', kind: 'art', name: 'Neon alley', description: 'rain-slick alley at night' },
  { id: 'art2', kind: 'art', name: 'Diner interior', description: 'chrome booths, daylight' },
  { id: 'char1', kind: 'char', name: 'Steve', description: '' },
];

function mockReply(jsonText) {
  messagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: jsonText }] });
}

beforeEach(() => {
  messagesCreate.mockReset();
  warnSpy.mockReset();
  hasKey = true;
  _resetAnthropicClientForTests();
});

describe('selectFrameReferences', () => {
  it('maps returned numbers to candidate ids, preserving order', async () => {
    mockReply(JSON.stringify({ ids: [3, 1] }));
    const out = await selectFrameReferences({ sceneText: 'Steve in the alley', candidates: CANDS, max: 6 });
    expect(out).toEqual(['char1', 'art1']);
  });

  it('drops out-of-range and duplicate numbers', async () => {
    mockReply(JSON.stringify({ ids: [1, 1, 9, 0, 2] }));
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(out).toEqual(['art1', 'art2']);
  });

  it('caps the result at max', async () => {
    mockReply(JSON.stringify({ ids: [1, 2, 3] }));
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 2 });
    expect(out).toEqual(['art1', 'art2']);
  });

  it('uses the enhancer model, not the main model', async () => {
    mockReply(JSON.stringify({ ids: [] }));
    await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(messagesCreate.mock.calls[0][0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('returns [] and warns on non-JSON output', async () => {
    mockReply('sorry, not json');
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns [] and warns when the SDK call throws', async () => {
    messagesCreate.mockRejectedValueOnce(new Error('network down'));
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns [] without calling the SDK when no API key', async () => {
    hasKey = false;
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: CANDS, max: 6 });
    expect(out).toEqual([]);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns [] without calling the SDK when candidates empty', async () => {
    const out = await selectFrameReferences({ sceneText: 'scene', candidates: [], max: 6 });
    expect(out).toEqual([]);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('returns [] without calling the SDK when sceneText is blank', async () => {
    const out = await selectFrameReferences({ sceneText: '   ', candidates: CANDS, max: 6 });
    expect(out).toEqual([]);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});
