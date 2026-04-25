import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();

vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { docToLlmMessage, loadHistoryForLlm } = await import('../src/mongo/messages.js');

beforeEach(() => {
  fakeDb.reset();
});

describe('docToLlmMessage', () => {
  it('renders an assistant doc as a string-content message', () => {
    const out = docToLlmMessage({ role: 'assistant', content: 'hello there' });
    expect(out).toEqual({ role: 'assistant', content: 'hello there' });
  });

  it('falls back to "(no reply)" when assistant content is empty', () => {
    const out = docToLlmMessage({ role: 'assistant', content: '' });
    expect(out).toEqual({ role: 'assistant', content: '(no reply)' });
  });

  it('renders a user doc with no attachments as a single text block', () => {
    const out = docToLlmMessage({ role: 'user', content: 'hi', attachments: [] });
    expect(out).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('renders one [user attached image] placeholder per attachment', () => {
    const out = docToLlmMessage({
      role: 'user',
      content: 'look at these',
      attachments: [
        { url: 'a', filename: 'a.png', content_type: 'image/png', size: 1 },
        { url: 'b', filename: 'b.png', content_type: 'image/png', size: 2 },
      ],
    });
    expect(out).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[user attached image]' },
        { type: 'text', text: '[user attached image]' },
        { type: 'text', text: 'look at these' },
      ],
    });
  });

  it('handles missing attachments field', () => {
    const out = docToLlmMessage({ role: 'user', content: 'hi' });
    expect(out).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('passes through assistant docs whose content is already an array of blocks', () => {
    const blocks = [
      { type: 'text', text: 'Calling tool…' },
      { type: 'tool_use', id: 'tu_1', name: 'list_beats', input: {} },
    ];
    const out = docToLlmMessage({ role: 'assistant', content: blocks });
    expect(out).toEqual({ role: 'assistant', content: blocks });
  });

  it('passes through user docs that hold tool_result blocks', () => {
    const blocks = [{ type: 'tool_result', tool_use_id: 'tu_1', content: '[]' }];
    const out = docToLlmMessage({ role: 'user', content: blocks, attachments: [] });
    expect(out).toEqual({ role: 'user', content: blocks });
  });
});

describe('loadHistoryForLlm', () => {
  it('returns docs in chronological order', async () => {
    const channelId = '111';
    await fakeDb.collection('messages').insertMany([
      { channel_id: channelId, role: 'user', content: 'first',
        attachments: [], created_at: new Date(1000) },
      { channel_id: channelId, role: 'assistant', content: 'reply',
        attachments: [], created_at: new Date(2000) },
    ]);
    const out = await loadHistoryForLlm(channelId);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'first' }] });
    expect(out[1]).toEqual({ role: 'assistant', content: 'reply' });
  });

  it('strips a leading orphan tool_result user doc when its tool_use was truncated off', async () => {
    const channelId = '222';
    await fakeDb.collection('messages').insertMany([
      { channel_id: channelId, role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: '[]' }],
        attachments: [], created_at: new Date(1000) },
      { channel_id: channelId, role: 'assistant', content: 'next reply',
        attachments: [], created_at: new Date(2000) },
    ]);
    const out = await loadHistoryForLlm(channelId);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: 'assistant', content: 'next reply' });
  });

  it('strips multiple consecutive leading orphan tool_result docs', async () => {
    const channelId = '333';
    await fakeDb.collection('messages').insertMany([
      { channel_id: channelId, role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: '[]' }],
        attachments: [], created_at: new Date(1000) },
      { channel_id: channelId, role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: '[]' }],
        attachments: [], created_at: new Date(1500) },
      { channel_id: channelId, role: 'assistant', content: 'finally',
        attachments: [], created_at: new Date(2000) },
    ]);
    const out = await loadHistoryForLlm(channelId);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: 'assistant', content: 'finally' });
  });

  it('does not strip a user doc whose array content mixes tool_result with non-tool_result blocks', async () => {
    const channelId = '444';
    await fakeDb.collection('messages').insertMany([
      { channel_id: channelId, role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_a', content: '[]' },
          { type: 'text', text: 'mixed' },
        ],
        attachments: [], created_at: new Date(1000) },
    ]);
    const out = await loadHistoryForLlm(channelId);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('does not strip a leading assistant tool_use doc', async () => {
    const channelId = '555';
    await fakeDb.collection('messages').insertMany([
      { channel_id: channelId, role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'noop', input: {} }],
        attachments: [], created_at: new Date(1000) },
      { channel_id: channelId, role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
        attachments: [], created_at: new Date(1001) },
    ]);
    const out = await loadHistoryForLlm(channelId);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('assistant');
    expect(out[1].role).toBe('user');
  });

  it('returns [] when every doc is an orphan tool_result', async () => {
    const channelId = '666';
    await fakeDb.collection('messages').insertMany([
      { channel_id: channelId, role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_z', content: '[]' }],
        attachments: [], created_at: new Date(1000) },
    ]);
    const out = await loadHistoryForLlm(channelId);
    expect(out).toEqual([]);
  });
});
