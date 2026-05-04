import { describe, it, expect, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor() {
      this.messages = { create: vi.fn(), countTokens: vi.fn() };
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

const { buildUserContent } = await import('../src/agent/loop.js');

describe('buildUserContent enhancement notes', () => {
  it('emits a single text block when no enhancement notes are provided', () => {
    const content = buildUserContent('hello world', []);
    expect(content).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('appends a second text block with the safety preamble when notes are provided', () => {
    const content = buildUserContent('hello world', [], 'Liam Neeson plays Hannibal Smith.');
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'hello world' });
    expect(content[1].type).toBe('text');
    expect(content[1].text).toMatch(/Interpretive notes from prompt pre-processor/);
    expect(content[1].text).toMatch(/hints, not authoritative/);
    expect(content[1].text).toContain('Liam Neeson plays Hannibal Smith.');
  });

  it('orders blocks correctly when both images and notes are present (image, text, notes)', () => {
    const attachments = [
      { url: 'https://example.com/x.png', filename: 'x.png', contentType: 'image/png', size: 100, kind: 'image' },
    ];
    const content = buildUserContent('hi', attachments, 'note content');
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } });
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('Attached images:');
    expect(content[1].text).toContain('hi');
    expect(content[2].type).toBe('text');
    expect(content[2].text).toContain('note content');
  });

  it('skips the notes block when enhancementNotes is falsy or whitespace', () => {
    expect(buildUserContent('x', [], null)).toHaveLength(1);
    expect(buildUserContent('x', [], '')).toHaveLength(1);
    expect(buildUserContent('x', [], '   \n  ')).toHaveLength(1);
  });
});
