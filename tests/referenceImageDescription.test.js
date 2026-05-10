// Tests for the tuned reference-image describer. Mocks the Anthropic client
// so we can assert request shape (system prompt, max_tokens, image media
// type, base64 payload) and response parsing (good JSON, code-fenced JSON,
// malformed JSON, network failure).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const messagesCreate = vi.fn();

vi.mock('../src/log.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/anthropic/client.js', () => ({
  getAnthropic: () => ({ messages: { create: messagesCreate } }),
}));

const { describeReferenceImage, REFERENCE_KINDS } = await import(
  '../src/llm/referenceImageDescription.js'
);

beforeEach(() => {
  messagesCreate.mockReset();
});

const tinyPng = Buffer.from('fake-png-bytes');

describe('describeReferenceImage', () => {
  it('exposes the supported kinds', () => {
    expect(REFERENCE_KINDS).toEqual(['auto', 'character', 'location', 'prop']);
  });

  it('returns parsed name + description for a normal JSON response', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '{"name": "Alice in profile", "description": "A woman with shoulder-length ash blonde hair, looking left."}',
        },
      ],
    });
    const out = await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/png',
      kind: 'character',
    });
    expect(out).toEqual({
      name: 'Alice in profile',
      description: 'A woman with shoulder-length ash blonde hair, looking left.',
    });
  });

  it('strips a stray code fence the model sometimes wraps around the JSON', async () => {
    messagesCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '```json\n{"name":"Diner","description":"Pink booths."}\n```',
        },
      ],
    });
    const out = await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/png',
      kind: 'location',
    });
    expect(out).toEqual({ name: 'Diner', description: 'Pink booths.' });
  });

  it('uses the location-specific system prompt when kind="location"', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"name":"x","description":"y"}' }],
    });
    await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/png',
      kind: 'location',
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const args = messagesCreate.mock.calls[0][0];
    expect(args.system).toMatch(/Architectural geometry/);
    expect(args.system).toMatch(/oxidized copper/i);
    // Image is forwarded with the supplied media type and base64 payload.
    const imageBlock = args.messages[0].content.find((b) => b.type === 'image');
    expect(imageBlock.source.media_type).toBe('image/png');
    expect(imageBlock.source.data).toBe(tinyPng.toString('base64'));
  });

  it('uses the character system prompt when kind="character"', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"name":"x","description":"y"}' }],
    });
    await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/png',
      kind: 'character',
    });
    const args = messagesCreate.mock.calls[0][0];
    expect(args.system).toMatch(/Hair color/);
    expect(args.system).toMatch(/character reference descriptions/i);
  });

  it('falls back to the auto prompt for an unknown kind', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"name":"x","description":"y"}' }],
    });
    await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/png',
      kind: 'frobozz',
    });
    const args = messagesCreate.mock.calls[0][0];
    // Auto covers everything: characters AND architecture AND lighting.
    expect(args.system).toMatch(/hair color/i);
    expect(args.system).toMatch(/structural geometry/i);
  });

  it('returns empty strings on malformed JSON without throwing', async () => {
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'not json at all' }],
    });
    const out = await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/png',
    });
    expect(out).toEqual({ name: '', description: '' });
  });

  it('returns empty strings on network failure without throwing', async () => {
    messagesCreate.mockRejectedValue(new Error('boom'));
    const out = await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/png',
    });
    expect(out).toEqual({ name: '', description: '' });
  });

  it('rejects unsupported content types up front (no API call)', async () => {
    const out = await describeReferenceImage({
      buffer: tinyPng,
      contentType: 'image/gif',
    });
    expect(out).toEqual({ name: '', description: '' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('rejects oversized buffers up front (no API call)', async () => {
    const huge = Buffer.alloc(5 * 1024 * 1024);
    const out = await describeReferenceImage({
      buffer: huge,
      contentType: 'image/png',
    });
    expect(out).toEqual({ name: '', description: '' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('rejects non-buffer input up front (no API call)', async () => {
    const out = await describeReferenceImage({
      buffer: 'a-string-not-a-buffer',
      contentType: 'image/png',
    });
    expect(out).toEqual({ name: '', description: '' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});
