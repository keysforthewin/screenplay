// --- fake-mongo mock must be registered before any DB-touching imports ---
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';
const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

import { webChannelId, reconstructDisplayTranscript } from '../src/web/chatHistory.js';

describe('webChannelId', () => {
  it('builds a per-project, per-username channel id', () => {
    expect(webChannelId('abc123', 'Steve')).toBe('web:abc123:Steve');
  });
  it('falls back to "web visitor" and trims', () => {
    expect(webChannelId('abc123', '  ')).toBe('web:abc123:web visitor');
    expect(webChannelId('abc123', undefined)).toBe('web:abc123:web visitor');
    expect(webChannelId('abc123', '  Ann ')).toBe('web:abc123:Ann');
  });
  it('isolates different usernames and different projects', () => {
    expect(webChannelId('p1', 'a')).not.toBe(webChannelId('p1', 'b'));
    expect(webChannelId('p1', 'a')).not.toBe(webChannelId('p2', 'a'));
  });
});

describe('reconstructDisplayTranscript', () => {
  it('keeps plain user + assistant text, drops tool plumbing and empties', () => {
    const docs = [
      { role: 'user', content: 'add a beat' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 't1', name: 'create_beat', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done — added beat 3.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'x', input: {} }] },
    ];
    expect(reconstructDisplayTranscript(docs)).toEqual([
      { role: 'user', text: 'add a beat' },
      { role: 'assistant', text: 'On it.' },
      { role: 'assistant', text: 'Done — added beat 3.' },
    ]);
  });
});

// --- DB-touching helpers; dynamic-import after the mock above ---
const { recordUserMessage, recordAgentTurns } = await import('../src/mongo/messages.js');
const { setHistoryClearedAt } = await import('../src/mongo/channelState.js');
const { loadWebDisplayHistory, computeHistoryStats } = await import('../src/web/chatHistory.js');
const { getLastAnthropicInputTokens } = await import('../src/mongo/tokenUsage.js');

// NOTE: brief used 'p'.repeat(24) but 'p' is not a valid hex char.
// resolveProjectId enforces /^[a-f0-9]{24}$/i, so we use '0'.repeat(24).
const PID = '0'.repeat(24);
const CH = 'web:' + PID + ':tester';

async function seedThread() {
  await recordUserMessage({
    projectId: PID,
    msg: { channelId: CH, guildId: null, thread: null, id: null,
      author: { id: 'web:tester', tag: 'web:tester', bot: false }, createdAt: new Date() },
    text: 'add a beat', attachments: [], displayName: 'tester',
  });
  await recordAgentTurns({
    projectId: PID, channelId: CH,
    turns: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
  });
}

describe('chatHistory DB helpers', () => {
  beforeEach(() => fakeDb.reset());

  it('loadWebDisplayHistory returns the reconstructed transcript', async () => {
    await seedThread();
    const msgs = await loadWebDisplayHistory(CH);
    expect(msgs).toEqual([
      { role: 'user', text: 'add a beat' },
      { role: 'assistant', text: 'Done.' },
    ]);
  });

  it('respects the clear watermark', async () => {
    await seedThread();
    await setHistoryClearedAt(CH, new Date(Date.now() + 1000));
    expect(await loadWebDisplayHistory(CH)).toEqual([]);
  });

  it('computeHistoryStats estimates tokens and reads last input tokens', async () => {
    await seedThread();
    await fakeDb.collection('token_usage').insertOne({
      kind: 'anthropic_text', channel_id: CH, meta: { input_tokens: 4242 },
      created_at: new Date(),
    });
    const stats = await computeHistoryStats(CH);
    expect(stats.estimated_tokens).toBeGreaterThan(0);
    expect(stats.last_input_tokens).toBe(4242);
  });

  it('getLastAnthropicInputTokens picks the newest row, null when none', async () => {
    expect(await getLastAnthropicInputTokens(CH)).toBeNull();
    await fakeDb.collection('token_usage').insertOne({
      kind: 'anthropic_text', channel_id: CH, meta: { input_tokens: 10 },
      created_at: new Date(1000),
    });
    await fakeDb.collection('token_usage').insertOne({
      kind: 'anthropic_text', channel_id: CH, meta: { input_tokens: 99 },
      created_at: new Date(2000),
    });
    expect(await getLastAnthropicInputTokens(CH)).toBe(99);
  });
});
