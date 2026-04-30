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
  aggregateToolUsage,
  aggregateSectionTokens,
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

  it('persists meta.tools when toolStats is provided', async () => {
    const toolStats = new Map();
    toolStats.set('list_beats', { count: 2, result_tokens: 800 });
    toolStats.set('generate_image', { count: 1, result_tokens: 60 });

    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 50 },
      toolStats,
    });

    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs).toHaveLength(1);
    expect(docs[0].meta.tools).toEqual({
      list_beats: { count: 2, result_tokens: 800 },
      generate_image: { count: 1, result_tokens: 60 },
    });
  });

  it('records meta.tools as empty object when no toolStats given (back-compat)', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 50 },
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs[0].meta.tools).toEqual({});
  });

  it('persists meta.section_tokens when sectionTokens is provided', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 50 },
      sectionTokens: {
        system: 1500,
        tools: 4200,
        message_history: 2300,
        user_input: 80,
      },
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs[0].meta.section_tokens).toEqual({
      system: 1500,
      director_notes: 0,
      tools: 4200,
      message_history: 2300,
      user_input: 80,
    });
  });

  it('omits meta.section_tokens when not supplied', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 50 },
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs[0].meta.section_tokens).toBeUndefined();
  });

  it('coerces invalid section values to 0 but still stores the snapshot', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 50 },
      sectionTokens: {
        system: 1500,
        tools: NaN,
        message_history: -42,
        user_input: '90',
      },
    });
    const docs = fakeDb.collection('token_usage')._docs;
    expect(docs[0].meta.section_tokens).toEqual({
      system: 1500,
      director_notes: 0,
      tools: 0,
      message_history: 0,
      user_input: 90,
    });
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

describe('aggregateToolUsage', () => {
  async function seedTools() {
    const aliceTools1 = new Map([
      ['list_beats', { count: 3, result_tokens: 900 }],
      ['generate_image', { count: 1, result_tokens: 50 }],
    ]);
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 20 },
      toolStats: aliceTools1,
    });
    setCreatedAt(0.1);

    const aliceTools2 = new Map([['list_beats', { count: 2, result_tokens: 600 }]]);
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 80, output_tokens: 10 },
      toolStats: aliceTools2,
    });
    setCreatedAt(0.1);

    const bobTools = new Map([
      ['generate_image', { count: 5, result_tokens: 250 }],
      ['create_character', { count: 1, result_tokens: 200 }],
    ]);
    await recordAnthropicTextUsage({
      discordUser: BOB,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 200, output_tokens: 50 },
      toolStats: bobTools,
    });
    setCreatedAt(0.1);
  }

  it('sums per-tool stats across all docs and sorts by tokens desc', async () => {
    await seedTools();
    const rows = await aggregateToolUsage({ since: null });

    const byName = Object.fromEntries(rows.map((r) => [r.tool_name, r]));
    expect(byName.list_beats.invocations).toBe(5);
    expect(byName.list_beats.result_tokens).toBe(1500);
    expect(byName.generate_image.invocations).toBe(6);
    expect(byName.generate_image.result_tokens).toBe(300);
    expect(byName.create_character.invocations).toBe(1);
    expect(byName.create_character.result_tokens).toBe(200);

    expect(rows[0].tool_name).toBe('list_beats');
  });

  it('respects since cutoff', async () => {
    const oldTools = new Map([['list_beats', { count: 99, result_tokens: 99000 }]]);
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 1, output_tokens: 1 },
      toolStats: oldTools,
    });
    setCreatedAt(40);

    const recentTools = new Map([['create_character', { count: 1, result_tokens: 50 }]]);
    await recordAnthropicTextUsage({
      discordUser: BOB,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 1, output_tokens: 1 },
      toolStats: recentTools,
    });
    setCreatedAt(0.1);

    const sevenDays = new Date(Date.now() - 7 * 86400000);
    const rows = await aggregateToolUsage({ since: sevenDays });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('create_character');
  });

  it('filters by userQuery substring', async () => {
    await seedTools();
    const rows = await aggregateToolUsage({ since: null, userQuery: 'bob' });
    const names = rows.map((r) => r.tool_name).sort();
    expect(names).toEqual(['create_character', 'generate_image']);
  });

  it('skips legacy docs that have no meta.tools field at all', async () => {
    // simulate a pre-migration doc with no `tools` field in meta
    await fakeDb.collection('token_usage').insertOne({
      kind: 'anthropic_text',
      discord_user_id: 'alice-id',
      discord_user_display_name: 'Alice',
      channel_id: 'c1',
      model: 'm',
      tokens: 15,
      meta: { input_tokens: 10, output_tokens: 5 },
      created_at: new Date(),
    });
    const rows = await aggregateToolUsage({ since: null });
    expect(rows).toEqual([]);
  });
});

describe('aggregateSectionTokens', () => {
  async function seedSections() {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 20 },
      sectionTokens: {
        system: 1000,
        tools: 4000,
        message_history: 2000,
        user_input: 100,
      },
    });
    setCreatedAt(0.1);

    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 90, output_tokens: 10 },
      sectionTokens: {
        system: 2000,
        tools: 4000,
        message_history: 4000,
        user_input: 200,
      },
    });
    setCreatedAt(0.1);

    await recordAnthropicTextUsage({
      discordUser: BOB,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 80, output_tokens: 5 },
      sectionTokens: {
        system: 3000,
        tools: 4000,
        message_history: 1500,
        user_input: 50,
      },
    });
    setCreatedAt(0.1);
  }

  it('returns zeroed averages and sample_count=0 when no docs', async () => {
    const stats = await aggregateSectionTokens({ since: null });
    expect(stats.sample_count).toBe(0);
    expect(stats.totals).toEqual({
      system: 0,
      director_notes: 0,
      tools: 0,
      message_history: 0,
      user_input: 0,
      total: 0,
    });
    expect(stats.averages).toEqual({
      system: 0,
      director_notes: 0,
      tools: 0,
      message_history: 0,
      user_input: 0,
      total: 0,
    });
  });

  it('sums totals and computes per-section averages over sample_count', async () => {
    await seedSections();
    const stats = await aggregateSectionTokens({ since: null });
    expect(stats.sample_count).toBe(3);
    // totals: system 6000, tools 12000, history 7500, user 350 → grand 25850
    expect(stats.totals).toEqual({
      system: 6000,
      director_notes: 0,
      tools: 12000,
      message_history: 7500,
      user_input: 350,
      total: 25850,
    });
    // averages: round(6000/3)=2000, round(12000/3)=4000, round(7500/3)=2500, round(350/3)=117
    expect(stats.averages).toEqual({
      system: 2000,
      director_notes: 0,
      tools: 4000,
      message_history: 2500,
      user_input: 117,
      total: 8617,
    });
  });

  it('skips docs without meta.section_tokens', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 0 },
      // no sectionTokens
    });
    setCreatedAt(0.1);
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 0 },
      sectionTokens: {
        system: 100,
        tools: 200,
        message_history: 300,
        user_input: 400,
      },
    });
    setCreatedAt(0.1);
    const stats = await aggregateSectionTokens({ since: null });
    expect(stats.sample_count).toBe(1);
    expect(stats.totals.system).toBe(100);
  });

  it('respects the since cutoff', async () => {
    await recordAnthropicTextUsage({
      discordUser: ALICE,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 0 },
      sectionTokens: {
        system: 9999,
        tools: 9999,
        message_history: 9999,
        user_input: 9999,
      },
    });
    setCreatedAt(40);
    await recordAnthropicTextUsage({
      discordUser: BOB,
      channelId: 'c1',
      model: 'm',
      totals: { input_tokens: 100, output_tokens: 0 },
      sectionTokens: {
        system: 100,
        tools: 200,
        message_history: 300,
        user_input: 50,
      },
    });
    setCreatedAt(0.1);

    const sevenDays = new Date(Date.now() - 7 * 86400000);
    const stats = await aggregateSectionTokens({ since: sevenDays });
    expect(stats.sample_count).toBe(1);
    expect(stats.totals.system).toBe(100);
  });

  it('filters by userQuery substring (case-insensitive)', async () => {
    await seedSections();
    const aliceOnly = await aggregateSectionTokens({ since: null, userQuery: 'alice' });
    expect(aliceOnly.sample_count).toBe(2);
    // alice: 1000+2000=3000 system → avg 1500
    expect(aliceOnly.averages.system).toBe(1500);

    const bobOnly = await aggregateSectionTokens({ since: null, userQuery: 'bob' });
    expect(bobOnly.sample_count).toBe(1);
    expect(bobOnly.averages.system).toBe(3000);
  });
});
