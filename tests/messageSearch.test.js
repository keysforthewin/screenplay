import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObjectId } from 'mongodb';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const { HANDLERS } = await import('../src/agent/handlers.js');
const { extractSearchableText, searchMessages, SEARCH_SCAN_LIMIT } = await import(
  '../src/mongo/messages.js'
);

const CHANNEL = '0';

function seed(doc = {}) {
  return fakeDb.collection('messages').insertOne({
    channel_id: CHANNEL,
    guild_id: null,
    thread_id: null,
    discord_message_id: null,
    role: 'user',
    author: null,
    content: '',
    attachments: [],
    created_at: new Date(),
    recorded_at: new Date(),
    ...doc,
  });
}

beforeEach(() => fakeDb.reset());

describe('extractSearchableText', () => {
  it('returns plain string content', () => {
    expect(extractSearchableText({ content: 'hello world' })).toBe('hello world');
  });

  it('returns empty string for empty doc', () => {
    expect(extractSearchableText({})).toBe('');
    expect(extractSearchableText({ content: null })).toBe('');
    expect(extractSearchableText(null)).toBe('');
  });

  it('extracts text blocks from array content', () => {
    const out = extractSearchableText({
      content: [
        { type: 'text', text: 'first text' },
        { type: 'text', text: 'second text' },
      ],
    });
    expect(out).toContain('first text');
    expect(out).toContain('second text');
  });

  it('extracts tool_use name and JSON input', () => {
    const out = extractSearchableText({
      content: [
        {
          type: 'tool_use',
          name: 'create_character',
          input: { name: 'Alice', has_mustache: true },
        },
      ],
    });
    expect(out).toContain('create_character');
    expect(out).toContain('Alice');
    expect(out).toContain('has_mustache');
  });

  it('extracts tool_result string content', () => {
    const out = extractSearchableText({
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Created Alice with a mustache.' },
      ],
    });
    expect(out).toContain('mustache');
  });

  it('extracts tool_result nested-array content', () => {
    const out = extractSearchableText({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: 'nested mustache result' }],
        },
      ],
    });
    expect(out).toContain('nested mustache result');
  });

  it('skips image blocks', () => {
    const out = extractSearchableText({
      content: [
        { type: 'image', source: { type: 'url', url: 'https://example.com/x.jpg' } },
        { type: 'text', text: 'caption text' },
      ],
    });
    expect(out).not.toContain('example.com');
    expect(out).toContain('caption text');
  });

  it('appends attachment filenames', () => {
    const out = extractSearchableText({
      content: 'see attached',
      attachments: [{ filename: 'mustache.jpg' }, { filename: 'beard.png' }],
    });
    expect(out).toContain('mustache.jpg');
    expect(out).toContain('beard.png');
  });

  it('appends author tag', () => {
    const out = extractSearchableText({
      content: 'hi there',
      author: { tag: 'steve#0001' },
    });
    expect(out).toContain('steve#0001');
  });

  it('caps text at 20KB', () => {
    const big = 'a'.repeat(30 * 1024);
    const out = extractSearchableText({ content: big });
    expect(out.length).toBe(20 * 1024);
  });
});

describe('searchMessages', () => {
  it('matches plain-string user content', async () => {
    await seed({ content: 'I want a character with a mustache' });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0].match.toLowerCase()).toBe('mustache');
    expect(results[0].excerpt).toContain('mustache');
  });

  it('excludes other channels', async () => {
    await seed({ content: 'mustache here', channel_id: 'other-channel' });
    await seed({ content: 'no match here' });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(0);
  });

  it('respects since_days', async () => {
    const oldDate = new Date(Date.now() - 30 * 86400000);
    const recentDate = new Date(Date.now() - 2 * 86400000);
    await seed({ content: 'old mustache', created_at: oldDate });
    await seed({ content: 'recent mustache', created_at: recentDate });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      sinceDays: 7,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toContain('recent');
  });

  it('respects until_days', async () => {
    const tooRecent = new Date(Date.now() - 1 * 86400000);
    const goodAge = new Date(Date.now() - 14 * 86400000);
    await seed({ content: 'too recent mustache', created_at: tooRecent });
    await seed({ content: 'good age mustache', created_at: goodAge });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      untilDays: 7,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toContain('good age');
  });

  it('combines since_days and until_days for a window', async () => {
    const tooOld = new Date(Date.now() - 30 * 86400000);
    const inWindow = new Date(Date.now() - 14 * 86400000);
    const tooRecent = new Date(Date.now() - 1 * 86400000);
    await seed({ content: 'too old mustache', created_at: tooOld });
    await seed({ content: 'in window mustache', created_at: inWindow });
    await seed({ content: 'too recent mustache', created_at: tooRecent });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      sinceDays: 21,
      untilDays: 7,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toContain('in window');
  });

  it('respects role filter', async () => {
    await seed({ role: 'user', content: 'user mentions mustache' });
    await seed({ role: 'assistant', content: 'assistant mentions mustache' });
    const re = new RegExp('mustache', 'i');
    const userOnly = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'user',
      limit: 20,
      contextChars: 100,
    });
    expect(userOnly.results).toHaveLength(1);
    expect(userOnly.results[0].role).toBe('user');
    const assistantOnly = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'assistant',
      limit: 20,
      contextChars: 100,
    });
    expect(assistantOnly.results).toHaveLength(1);
    expect(assistantOnly.results[0].role).toBe('assistant');
    const both = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(both.results).toHaveLength(2);
  });

  it('caps matches per doc at 3', async () => {
    await seed({
      content: 'mustache mustache mustache mustache mustache mustache',
    });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(3);
  });

  it('respects global limit across docs', async () => {
    await seed({
      content: 'mustache mustache mustache mustache mustache mustache',
      created_at: new Date(2026, 0, 1),
    });
    await seed({ content: 'another mustache', created_at: new Date(2026, 0, 5) });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 2,
      contextChars: 100,
    });
    expect(results).toHaveLength(2);
  });

  it('matches inside tool_use input JSON', async () => {
    await seed({
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'create_character', input: { name: 'Mr. Mustacheman' } },
      ],
    });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
  });

  it('matches inside tool_result content', async () => {
    await seed({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Created Mr. Mustacheman.' }],
    });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
  });

  it('matches attachment filename', async () => {
    await seed({
      content: 'see attached',
      attachments: [{ filename: 'mustache.jpg', url: 'x', content_type: 'image/jpeg', size: 1 }],
    });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0].match.toLowerCase()).toBe('mustache');
  });

  it('matches author tag', async () => {
    await seed({ content: 'plain message body', author: { tag: 'mustacheking#0001' } });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
  });

  it('returns excerpt with ellipses when truncated', async () => {
    const long = 'A'.repeat(500) + ' mustache ' + 'B'.repeat(500);
    await seed({ content: long });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(1);
    expect(results[0].excerpt).toContain('mustache');
    expect(results[0].excerpt.startsWith('…')).toBe(true);
    expect(results[0].excerpt.endsWith('…')).toBe(true);
  });

  it('respects 20KB doc-text cap', async () => {
    const padding = 'A'.repeat(20 * 1024);
    await seed({ content: `${padding} mustache` });
    const re = new RegExp('mustache', 'i');
    const { results } = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(results).toHaveLength(0);
  });

  it('reports scanned count and scan_limit_hit=false under cap', async () => {
    await seed({ content: 'mustache one' });
    await seed({ content: 'beardy two' });
    const re = new RegExp('mustache', 'i');
    const out = await searchMessages({
      channelId: CHANNEL,
      regex: re,
      role: 'any',
      limit: 20,
      contextChars: 100,
    });
    expect(out.scanned).toBe(2);
    expect(out.scan_limit_hit).toBe(false);
    expect(SEARCH_SCAN_LIMIT).toBe(5000);
  });
});

describe('search_message_history handler', () => {
  it('returns parsable JSON with results', async () => {
    await seed({ content: 'I want a character with a mustache' });
    const out = await HANDLERS.search_message_history({ pattern: 'mustache' });
    const parsed = JSON.parse(out);
    expect(parsed.match_count).toBe(1);
    expect(parsed.flags).toBe('i');
    expect(parsed.results[0].match.toLowerCase()).toBe('mustache');
  });

  it('rejects invalid regex with error string (does not throw)', async () => {
    const out = await HANDLERS.search_message_history({ pattern: '(unclosed' });
    expect(typeof out).toBe('string');
    expect(out).toMatch(/^Error: invalid regex/);
  });

  it('strips disallowed flag characters', async () => {
    await seed({ content: 'mustache' });
    const out = await HANDLERS.search_message_history({
      pattern: 'MUSTACHE',
      flags: 'igxyz',
    });
    const parsed = JSON.parse(out);
    expect(parsed.flags).toBe('i');
    expect(parsed.match_count).toBe(1);
  });

  it('treats unknown role as any', async () => {
    await seed({ role: 'user', content: 'mustache one' });
    await seed({ role: 'assistant', content: 'mustache two' });
    const out = await HANDLERS.search_message_history({
      pattern: 'mustache',
      role: 'bogus',
    });
    const parsed = JSON.parse(out);
    expect(parsed.match_count).toBe(2);
  });

  it('serializes _id as a string', async () => {
    const id = new ObjectId();
    await fakeDb.collection('messages').insertOne({
      _id: id,
      channel_id: CHANNEL,
      role: 'user',
      content: 'mustache present',
      attachments: [],
      created_at: new Date(),
      recorded_at: new Date(),
    });
    const out = await HANDLERS.search_message_history({ pattern: 'mustache' });
    const parsed = JSON.parse(out);
    expect(parsed.results[0]._id).toBe(id.toString());
  });

  it('returns empty results without throwing when nothing matches', async () => {
    await seed({ content: 'nothing here' });
    const out = await HANDLERS.search_message_history({ pattern: 'nonexistent' });
    const parsed = JSON.parse(out);
    expect(parsed.match_count).toBe(0);
    expect(parsed.results).toEqual([]);
    expect(parsed.scanned).toBe(1);
  });

  it('completes quickly when scanning very large content (cap defense)', async () => {
    // Without the 20KB cap, scanning 1MB of content would be slow even with a
    // linear pattern. With the cap, extractSearchableText slices to 20KB first.
    await seed({ content: 'a'.repeat(1024 * 1024) });
    const start = Date.now();
    const out = await HANDLERS.search_message_history({ pattern: 'aaaa' });
    const elapsed = Date.now() - start;
    const parsed = JSON.parse(out);
    expect(parsed.match_count).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000);
  });
});
