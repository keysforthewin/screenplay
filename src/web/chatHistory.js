// Per-username+project isolation and display-history reconstruction for the
// SPA AI chat. The web chat keys its conversation off a synthetic channel id
// (web:<projectId>:<username>) so each logged-in user gets their own thread,
// separate from Discord (config.discord.movieChannelId) and from other users.

import { config } from '../config.js';
import { getHistoryClearedAt } from '../mongo/channelState.js';
import { loadHistoryForLlm, loadChannelMessagesSince } from '../mongo/messages.js';
import { estimateMessageTokens } from '../agent/historyTrim.js';
import { getLastAnthropicInputTokens } from '../mongo/tokenUsage.js';

export function webChannelId(projectId, username) {
  const user = (typeof username === 'string' ? username.trim() : '') || 'web visitor';
  return `web:${projectId}:${user}`;
}

// Turn raw stored message docs into a lightweight display transcript: user and
// assistant *text* only. Tool_use / tool_result blocks and empty turns are
// dropped — the dialog shows the human-readable conversation, not plumbing.
function textFromContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
  return '';
}

export function reconstructDisplayTranscript(docs) {
  const out = [];
  for (const doc of docs || []) {
    if (doc.role !== 'user' && doc.role !== 'assistant') continue;
    const text = textFromContent(doc.content);
    if (text) out.push({ role: doc.role, text });
  }
  return out;
}

export async function loadWebDisplayHistory(channelId) {
  const clearedAt = await getHistoryClearedAt(channelId);
  const docs = await loadChannelMessagesSince(channelId, { since: clearedAt });
  return reconstructDisplayTranscript(docs);
}

// Estimated size of the history actually sent to the model (post-watermark,
// HISTORY_LIMIT window) plus the real input_tokens of the most recent request.
export async function computeHistoryStats(channelId) {
  const clearedAt = await getHistoryClearedAt(channelId);
  const history = await loadHistoryForLlm(channelId, {
    maxAgeMs: config.trim.historyWindowMs,
    since: clearedAt,
  });
  const estimated_tokens = history.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const last_input_tokens = await getLastAnthropicInputTokens(channelId);
  return { estimated_tokens, last_input_tokens };
}
