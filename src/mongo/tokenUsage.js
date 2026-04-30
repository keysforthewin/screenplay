import { getDb } from './client.js';

const col = () => getDb().collection('token_usage');

export const KIND_ANTHROPIC_TEXT = 'anthropic_text';
export const KIND_ANTHROPIC_IMAGE_INPUT = 'anthropic_image_input';
export const KIND_GEMINI_IMAGE = 'gemini_image';

function envelope({ kind, discordUser, channelId, model, tokens, meta }) {
  return {
    kind,
    discord_user_id: discordUser?.id || null,
    discord_user_display_name: discordUser?.displayName || null,
    channel_id: channelId || null,
    model: model || null,
    tokens: Number(tokens) || 0,
    meta: meta || {},
    created_at: new Date(),
  };
}

export async function recordAnthropicTextUsage({ discordUser, channelId, model, totals }) {
  const inputTokens = Number(totals?.input_tokens) || 0;
  const outputTokens = Number(totals?.output_tokens) || 0;
  const tokens = inputTokens + outputTokens;
  if (tokens <= 0) return;
  await col().insertOne(
    envelope({
      kind: KIND_ANTHROPIC_TEXT,
      discordUser,
      channelId,
      model,
      tokens,
      meta: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: Number(totals?.cache_creation_input_tokens) || 0,
        cache_read_input_tokens: Number(totals?.cache_read_input_tokens) || 0,
        iteration_count: Number(totals?.iteration_count) || 0,
      },
    }),
  );
}

export async function recordAnthropicImageInputUsage({
  discordUser,
  channelId,
  model,
  perImageTokens,
}) {
  const list = Array.isArray(perImageTokens) ? perImageTokens.map((n) => Number(n) || 0) : [];
  const tokens = list.reduce((a, b) => a + b, 0);
  if (tokens <= 0) return;
  await col().insertOne(
    envelope({
      kind: KIND_ANTHROPIC_IMAGE_INPUT,
      discordUser,
      channelId,
      model,
      tokens,
      meta: { image_count: list.length, per_image_tokens: list },
    }),
  );
}

export async function recordGeminiImageUsage({ discordUser, channelId, model, usageMetadata }) {
  if (!usageMetadata) return;
  const promptTokens = Number(usageMetadata.promptTokenCount) || 0;
  const candidatesTokens = Number(usageMetadata.candidatesTokenCount) || 0;
  const totalTokens =
    Number(usageMetadata.totalTokenCount) || promptTokens + candidatesTokens;
  if (totalTokens <= 0) return;
  await col().insertOne(
    envelope({
      kind: KIND_GEMINI_IMAGE,
      discordUser,
      channelId,
      model,
      tokens: totalTokens,
      meta: {
        prompt_token_count: promptTokens,
        candidates_token_count: candidatesTokens,
        total_token_count: totalTokens,
      },
    }),
  );
}

function kindBucketField(kind) {
  if (kind === KIND_ANTHROPIC_TEXT) return 'anthropic_text';
  if (kind === KIND_ANTHROPIC_IMAGE_INPUT) return 'anthropic_image_input';
  if (kind === KIND_GEMINI_IMAGE) return 'gemini_image';
  return null;
}

export async function aggregateUsage({ since = null, userQuery = null } = {}) {
  const query = {};
  if (since instanceof Date) query.created_at = { $gte: since };
  const docs = await col().find(query).sort({ created_at: 1 }).toArray();

  const byUser = new Map();
  for (const doc of docs) {
    const id = doc.discord_user_id || '(unknown)';
    let row = byUser.get(id);
    if (!row) {
      row = {
        discord_user_id: id,
        discord_user_display_name: doc.discord_user_display_name || id,
        anthropic_text: 0,
        anthropic_image_input: 0,
        gemini_image: 0,
        total: 0,
        _latest: doc.created_at,
      };
      byUser.set(id, row);
    } else if (
      doc.created_at &&
      (!row._latest || new Date(doc.created_at) >= new Date(row._latest))
    ) {
      row._latest = doc.created_at;
      if (doc.discord_user_display_name) {
        row.discord_user_display_name = doc.discord_user_display_name;
      }
    }
    const field = kindBucketField(doc.kind);
    if (field) {
      const t = Number(doc.tokens) || 0;
      row[field] += t;
      row.total += t;
    }
  }

  let rows = Array.from(byUser.values()).map((r) => {
    const { _latest, ...rest } = r;
    return rest;
  });

  if (userQuery && typeof userQuery === 'string' && userQuery.trim()) {
    const q = userQuery.trim().toLowerCase();
    const exact = rows.filter(
      (r) => (r.discord_user_display_name || '').toLowerCase() === q,
    );
    if (exact.length) {
      rows = exact;
    } else {
      rows = rows.filter((r) =>
        (r.discord_user_display_name || '').toLowerCase().includes(q),
      );
    }
  }

  rows.sort((a, b) => b.total - a.total);
  return rows;
}
