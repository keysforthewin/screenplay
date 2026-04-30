import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb } from './_fakeMongo.js';

const fakeDb = createFakeDb();
vi.mock('../src/mongo/client.js', () => ({
  getDb: () => fakeDb,
  connectMongo: async () => fakeDb,
}));

const {
  recordAnthropicTextUsage,
  recordAnthropicImageInputUsage,
  recordGeminiImageUsage,
  aggregateUsage,
} = await import('../src/mongo/tokenUsage.js');

const ALICE = { id: 'alice-id', displayName: 'Alice' };
const BOB = { id: 'bob-id', displayName: 'Bob' };

beforeEach(() => fakeDb.reset());

function setCreatedAt(daysAgo) {
  // Patch the most recently inserted token_usage doc's created_at
  const docs = fakeDb.collection('token_usage')._docs;
  const last = docs[docs.length - 1];
  last.created_at = new Date(Date.now() - daysAgo * 86400000);
}

describe('record* writers', () => {
  it('writes an anthropic_text doc with summed input/output', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'claude-test',
      totals: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        iteration_count: 3,
      },
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe('anthropic_text');
    expect(docs[0].discord_user_id).toBe('alice-id');
    expect(docs[0].discord_user_display_name).toBe('Alice');
    expect(docs[0].tokens).toBe(150);
    expect(docs[0].meta.iteration_count).toBe(3);
    expect(docs[0].meta.cache_creation_input_tokens).toBe(10);
  });

  it('skips anthropic_text doc when total is 0', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 0, output_tokens: 0 },
    });
    expect(fakeDb.collection('token_usage')._docs).toHaveLength(0);
  });

  it('writes an anthropic_image_input doc summing per-image tokens', async () => {
    await recordAnthropicImageInputUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'claude-test',
      perImageTokens: [120, 320],
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe('anthropic_image_input');
    expect(docs[0].tokens).toBe(440);
    expect(docs[0].meta.image_count).toBe(2);
    expect(docs[0].meta.per_image_tokens).toEqual([120, 320]);
  });

  it('writes a gemini_image doc from usageMetadata', async () => {
    await recordGeminiImageUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'gemini-2.5-flash-image',
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 3000,
        totalTokenCount: 3012,
      },
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe('gemini_image');
    expect(docs[0].tokens).toBe(3012);
    expect(docs[0].meta.prompt_token_count).toBe(12);
    expect(docs[0].meta.candidates_token_count).toBe(3000);
  });

  it('falls back to prompt+candidates when totalTokenCount is missing', async () => {
    await recordGeminiImageUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'g',
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 100 },
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs[0].tokens).toBe(107);
  });

  it('skips gemini_image doc when usageMetadata is missing', async () => {
    await recordGeminiImageUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'g',
      usageMetadata: null,
    });
    expect(fakeDb.collection('token_usage')._docs).toHaveLength(0);
  });
});

describe('aggregateUsage', () => {
  async function seedAll() {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 50 },
    });
    setCreatedAt(0.1);
    await recordAnthropicImageInputUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      perImageTokens: [120],
    });
    setCreatedAt(0.1);
    await recordGeminiImageUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'g',
      usageMetadata: { totalTokenCount: 2000 },
    });
    setCreatedAt(0.1);
    await recordAnthropicTextUsage({
      discordUser: BOB,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 30, output_tokens: 20 },
    });
    setCreatedAt(0.1);
  }

  it('groups per user and sums each kind', async () => {
    await seedAll();
    const rows = await aggregateUsage({ since: null });
    const alice = rows.find((r) => r.discord_user_display_name === 'Alice');
    const bob = rows.find((r) => r.discord_user_display_name === 'Bob');
    expect(alice).toBeTruthy();
    expect(alice.anthropic_text).toBe(150);
    expect(alice.anthropic_image_input).toBe(120);
    expect(alice.gemini_image).toBe(2000);
    expect(alice.total).toBe(2270);
    expect(bob.anthropic_text).toBe(50);
    expect(bob.total).toBe(50);
  });

  it('sorts rows by total descending', async () => {
    await seedAll();
    const rows = await aggregateUsage({ since: null });
    expect(rows[0].discord_user_display_name).toBe('Alice');
    expect(rows[1].discord_user_display_name).toBe('Bob');
  });

  it('respects the since cutoff', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 9, output_tokens: 1 },
    });
    setCreatedAt(40); // 40 days ago — outside any window
    await recordAnthropicTextUsage({
      discordUser: BOB,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 99, output_tokens: 1 },
    });
    setCreatedAt(0.1);

    const sevenDays = new Date(Date.now() - 7 * 86400000);
    const rows = await aggregateUsage({ since: sevenDays });
    expect(rows).toHaveLength(1);
    expect(rows[0].discord_user_display_name).toBe('Bob');
  });

  it('userQuery: case-insensitive exact match wins over substring', async () => {
    await recordAnthropicTextUsage({
      discordUser: { id: 'u1', displayName: 'Sam' },
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 10, output_tokens: 0 },
    });
    setCreatedAt(0.1);
    await recordAnthropicTextUsage({
      discordUser: { id: 'u2', displayName: 'Samantha' },
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 0 },
    });
    setCreatedAt(0.1);

    const exact = await aggregateUsage({ since: null, userQuery: 'sam' });
    expect(exact).toHaveLength(1);
    expect(exact[0].discord_user_display_name).toBe('Sam');

    const partial = await aggregateUsage({ since: null, userQuery: 'mant' });
    expect(partial).toHaveLength(1);
    expect(partial[0].discord_user_display_name).toBe('Samantha');
  });

  it('userQuery: returns empty array when nothing matches', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 10, output_tokens: 0 },
    });
    const rows = await aggregateUsage({ since: null, userQuery: 'no-such-user' });
    expect(rows).toEqual([]);
  });

  it('uses the most recent display name for a user when it changes', async () => {
    await recordAnthropicTextUsage({
      discordUser: { id: 'shared', displayName: 'OldName' },
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 5, output_tokens: 0 },
    });
    setCreatedAt(2);
    await recordAnthropicTextUsage({
      discordUser: { id: 'shared', displayName: 'NewName' },
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 7, output_tokens: 0 },
    });
    setCreatedAt(0.1);

    const rows = await aggregateUsage({ since: null });
    expect(rows).toHaveLength(1);
    expect(rows[0].discord_user_display_name).toBe('NewName');
    expect(rows[0].anthropic_text).toBe(12);
  });
});
