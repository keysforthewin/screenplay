import { getDb } from './client.js';

const HISTORY_LIMIT = 60;
const col = () => getDb().collection('messages');

export async function recordUserMessage({ msg, text, attachments }) {
  await col().insertOne({
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
  });
}

export async function recordAssistantMessage({ channelId, guildId = null, threadId = null, text }) {
  await col().insertOne({
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
    content,
    attachments: [],
    created_at: new Date(now + i),
    recorded_at: new Date(),
  }));
  await col().insertMany(docs);
}

export function docToLlmMessage(doc) {
  if (Array.isArray(doc.content)) {
    return { role: doc.role, content: doc.content };
  }
  if (doc.role === 'assistant') {
    return { role: 'assistant', content: doc.content || '(no reply)' };
  }
  const blocks = [];
  for (const _ of doc.attachments || []) {
    blocks.push({ type: 'text', text: '[user attached image]' });
  }
  blocks.push({ type: 'text', text: doc.content || '' });
  return { role: 'user', content: blocks };
}

export async function loadHistoryForLlm(channelId) {
  const docs = await col()
    .find({ channel_id: channelId })
    .sort({ created_at: -1, _id: -1 })
    .limit(HISTORY_LIMIT)
    .toArray();
  docs.reverse();
  return docs.map(docToLlmMessage);
}
