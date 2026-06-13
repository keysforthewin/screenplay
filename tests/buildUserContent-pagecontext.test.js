// The web chat injects a page-context block into the live agent turn. It must
// appear only when provided, and sit after the user text but before the
// (non-authoritative) prompt-enhancer notes block.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() { this.messages = { create: vi.fn(), countTokens: vi.fn() }; }
  },
}));
vi.mock('../src/log.js', () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => ({}),
  connectMongo: async () => ({}),
}));

const { buildUserContent } = await import('../src/agent/loop.js');

const texts = (content) => content.filter((c) => c.type === 'text').map((c) => c.text);

describe('buildUserContent pageContext block', () => {
  it('omits the block when pageContext is null', () => {
    expect(texts(buildUserContent('hello', [], null, null, null))).toEqual(['hello']);
  });

  it('appends the block after the user text', () => {
    expect(texts(buildUserContent('hello', [], null, null, 'PAGE NOTE'))).toEqual(['hello', 'PAGE NOTE']);
  });

  it('orders page context before enhancement notes', () => {
    const out = texts(buildUserContent('hello', [], 'ENH', null, 'PAGE NOTE'));
    expect(out[0]).toBe('hello');
    expect(out[1]).toBe('PAGE NOTE');
    expect(out[2]).toContain('ENH');
  });
});
