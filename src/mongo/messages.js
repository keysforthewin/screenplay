import { getDb } from './client.js';
import { ALLOWED_IMAGE_TYPES } from './imageBytes.js';
import { logger } from '../log.js';
import { config } from '../config.js';

const HISTORY_LIMIT = 60;
const DEFAULT_HISTORY_WINDOW_MS = 60 * 60 * 1000;
export const SEARCH_SCAN_LIMIT = 5000;
const SEARCH_TEXT_CAP = 20 * 1024;
const PER_DOC_MATCH_CAP = 3;
const col = () => getDb().collection('messages');

// RAG indexing — lazy import to avoid circular deps. Best-effort, never throws.
let _insertCount = 0;
async function ragIndexInserted(doc) {
  try {
    const { indexMessage } = await import('../rag/indexer.js');
    indexMessage(doc).catch(() => {});
  } catch {}
  _insertCount += 1;
  const every = config.rag?.pruneEveryN || 100;
  if (doc?.channel_id && _insertCount % every === 0) {
    try {
      const { pruneMessagesOlderThan } = await import('../rag/indexer.js');
      pruneMessagesOlderThan(doc.channel_id, config.rag.messageWindow).catch(() => {});
    } catch {}
  }
}

export async function recordUserMessage({ msg, text, attachments }) {
  const doc = {
    channel_id: msg.channelId,
    guild_id: msg.guildId || null,
    thread_id: msg.thread?.id || null,
    discord_message_id: msg.id,
    role: 'user',
    author: {
      id: msg.author.id,
      tag: msg.author.tag,
      bot: !!msg.author.bot,
    },
    content: text || '',
    attachments: attachments.map((a) => ({
      url: a.url,
      filename: a.filename,
      content_type: a.contentType,
      size: a.size,
    })),
    created_at: msg.createdAt || new Date(),
    recorded_at: new Date(),
  };
  const res = await col().insertOne(doc);
  doc._id = res.insertedId;
  logger.info(`mongo: msg recorded role=user attach=${attachments.length}`);
  ragIndexInserted(doc);
}

export async function recordAssistantMessage({ channelId, guildId = null, threadId = null, text }) {
  const doc = {
    channel_id: channelId,
    guild_id: guildId,
    thread_id: threadId,
    discord_message_id: null,
    role: 'assistant',
    author: null,
    content: text || '',
    attachments: [],
    created_at: new Date(),
    recorded_at: new Date(),
  };
  const res = await col().insertOne(doc);
  doc._id = res.insertedId;
  logger.info('mongo: msg recorded role=assistant');
  ragIndexInserted(doc);
}

// describe_image tool returns a content array containing a base64 image block.
// That image is needed in the live request so the model can see it, but
// persisting it into the rolling message history would bloat Mongo by megabytes
// per call. Replace any image block with a stub text block before insert; the
// agent can re-invoke describe_image if it needs to look again.
function stripBase64ImagesForPersist(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const inner = block.content.map((b) => {
        if (b && b.type === 'image') {
          return {
            type: 'text',
            text: '[image bytes elided from history — call describe_image again to re-view]',
          };
        }
        return b;
      });
      return { ...block, content: inner };
    }
    return block;
  });
}

export async function recordAgentTurns({ channelId, guildId = null, threadId = null, turns }) {
  if (!turns || !turns.length) return;
  const now = Date.now();
  const docs = turns.map(({ role, content }, i) => ({
    channel_id: channelId,
    guild_id: guildId,
    thread_id: threadId,
    discord_message_id: null,
    role,
    author: null,
    content: stripBase64ImagesForPersist(content),
    attachments: [],
    created_at: new Date(now + i),
    recorded_at: new Date(),
  }));
  const res = await col().insertMany(docs);
  // Stamp _id back on the docs so RAG indexing can use them.
  if (res?.insertedIds) {
    for (const [k, v] of Object.entries(res.insertedIds)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && docs[idx]) docs[idx]._id = v;
    }
  }
  logger.info(`mongo: msgs recorded role=agent count=${docs.length}`);
  for (const d of docs) {
    if (!d._id) continue;
    ragIndexInserted(d);
  }
}

export function docToLlmMessage(doc) {
  if (Array.isArray(doc.content)) {
    return { role: doc.role, content: doc.content };
  }
  if (doc.role === 'assistant') {
    return { role: 'assistant', content: doc.content || '(no reply)' };
  }
  const blocks = [];
  for (const a of doc.attachments || []) {
    if (a && a.content_type && ALLOWED_IMAGE_TYPES.has(a.content_type)) {
      blocks.push({ type: 'text', text: '[user attached image]' });
    } else {
      const name = a?.filename || 'unnamed';
      const type = a?.content_type || 'unknown';
      blocks.push({ type: 'text', text: `[user attached file: ${name} (${type})]` });
    }
  }
  blocks.push({ type: 'text', text: doc.content || '' });
  return { role: 'user', content: blocks };
}

function isOrphanToolResultDoc(doc) {
  return (
    doc.role === 'user' &&
    Array.isArray(doc.content) &&
    doc.content.length > 0 &&
    doc.content.every((b) => b && b.type === 'tool_result')
  );
}

// Anthropic requires every tool_use block to be answered by a tool_result block
// in the IMMEDIATELY following user message. History can drift out of that
// invariant if a previous response was truncated (stop_reason='max_tokens' with
// a tool_use still in content) or if recordAgentTurns partially failed. Heal at
// load time by inserting/augmenting synthetic tool_result blocks for any
// missing ids — non-destructive, keeps the surrounding context intact.
export function balanceToolUses(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const toolUseIds = msg.content
      .filter((b) => b && b.type === 'tool_use' && b.id)
      .map((b) => b.id);
    if (!toolUseIds.length) {
      out.push(msg);
      continue;
    }
    out.push(msg);

    const next = messages[i + 1];
    const nextResults =
      next?.role === 'user' && Array.isArray(next.content)
        ? next.content.filter((b) => b && b.type === 'tool_result' && b.tool_use_id)
        : [];
    const haveIds = new Set(nextResults.map((b) => b.tool_use_id));
    const missing = toolUseIds.filter((id) => !haveIds.has(id));
    if (!missing.length) continue;

    const synthetic = missing.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: 'Tool result missing (interrupted run).',
      is_error: true,
    }));

    if (nextResults.length) {
      // Next message is already the tool_result message — augment it and skip
      // the original (otherwise we'd push it twice).
      out.push({ role: 'user', content: [...next.content, ...synthetic] });
      i++;
    } else {
      // Either no next message, or the next message is unrelated — inject a
      // standalone synthetic tool_result message right after the assistant.
      out.push({ role: 'user', content: synthetic });
    }
  }
  return out;
}

function blockText(block) {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (block.type === 'text') return String(block.text || '');
  if (block.type === 'tool_use') {
    let inputStr = '';
    try {
      inputStr = JSON.stringify(block.input || {});
    } catch {
      inputStr = '';
    }
    return `${block.name || ''} ${inputStr}`.trim();
  }
  if (block.type === 'tool_result') {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(blockText).filter(Boolean).join('\n');
    return '';
  }
  return '';
}

export function extractSearchableText(doc) {
  if (!doc) return '';
  const parts = [];
  const c = doc.content;
  if (typeof c === 'string') {
    parts.push(c);
  } else if (Array.isArray(c)) {
    const joined = c.map(blockText).filter(Boolean).join('\n');
    if (joined) parts.push(joined);
  }
  if (Array.isArray(doc.attachments)) {
    for (const a of doc.attachments) {
      if (a && a.filename) parts.push(String(a.filename));
    }
  }
  if (doc.author?.tag) parts.push(String(doc.author.tag));
  let combined = parts.join('\n');
  if (combined.length > SEARCH_TEXT_CAP) {
    combined = combined.slice(0, SEARCH_TEXT_CAP);
  }
  return combined;
}

function makeExcerpt(text, start, len, contextChars) {
  const half = Math.floor(contextChars / 2);
  const from = Math.max(0, start - half);
  const to = Math.min(text.length, start + len + half);
  let snippet = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) snippet = `…${snippet}`;
  if (to < text.length) snippet = `${snippet}…`;
  return snippet;
}

export async function searchMessages({
  channelId,
  regex,
  sinceDays,
  untilDays,
  role,
  limit,
  contextChars,
}) {
  const query = { channel_id: channelId };
  if (role === 'user' || role === 'assistant') query.role = role;

  const now = Date.now();
  const created = {};
  if (sinceDays && Number(sinceDays) > 0) {
    created.$gte = new Date(now - Number(sinceDays) * 86400000);
  }
  if (untilDays && Number(untilDays) > 0) {
    created.$lte = new Date(now - Number(untilDays) * 86400000);
  }
  if (Object.keys(created).length) query.created_at = created;

  const docs = await col()
    .find(query)
    .sort({ created_at: -1, _id: -1 })
    .limit(SEARCH_SCAN_LIMIT)
    .toArray();

  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const results = [];
  outer: for (const doc of docs) {
    const text = extractSearchableText(doc);
    if (!text) continue;
    const re = new RegExp(regex.source, flags);
    let docMatches = 0;
    let m;
    while (docMatches < PER_DOC_MATCH_CAP && (m = re.exec(text)) !== null) {
      results.push({
        _id: doc._id,
        discord_message_id: doc.discord_message_id || null,
        role: doc.role,
        created_at: doc.created_at,
        author_tag: doc.author?.tag || null,
        excerpt: makeExcerpt(text, m.index, m[0].length, contextChars),
        match: m[0],
      });
      docMatches++;
      if (results.length >= limit) break outer;
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  return {
    results,
    scanned: docs.length,
    scan_limit_hit: docs.length >= SEARCH_SCAN_LIMIT,
  };
}

export async function loadHistoryForLlm(
  channelId,
  { maxAgeMs = DEFAULT_HISTORY_WINDOW_MS, since = null } = {},
) {
  const query = { channel_id: channelId };
  const createdAt = {};
  if (maxAgeMs && maxAgeMs > 0) {
    createdAt.$gte = new Date(Date.now() - maxAgeMs);
  }
  if (since instanceof Date) {
    createdAt.$gt = since;
  }
  if (Object.keys(createdAt).length) {
    query.created_at = createdAt;
  }
  const docs = await col()
    .find(query)
    .sort({ created_at: -1, _id: -1 })
    .limit(HISTORY_LIMIT)
    .toArray();
  docs.reverse();
  while (docs.length && isOrphanToolResultDoc(docs[0])) {
    docs.shift();
  }
  return balanceToolUses(docs.map(docToLlmMessage));
}
