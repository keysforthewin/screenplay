import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import { keyedMutex } from '../util/mutex.js';
import { runAgent } from '../agent/loop.js';
import {
  loadHistoryForLlm,
  recordUserMessage,
  recordAssistantMessage,
  recordAgentTurns,
} from '../mongo/messages.js';
import { sendReply } from './reply.js';

const mutex = keyedMutex();

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function extractImageAttachments(msg) {
  return [...msg.attachments.values()]
    .filter((a) => ALLOWED_IMAGE_TYPES.has(a.contentType))
    .map((a) => ({
      url: a.url,
      filename: a.name,
      contentType: a.contentType,
      size: a.size,
    }));
}

export async function handleMessage(msg) {
  if (msg.author.bot) return;
  if (msg.channelId !== config.discord.movieChannelId) return;
  const text = msg.content?.trim() || '';
  const attachments = extractImageAttachments(msg);
  if (!text && !attachments.length) return;

  await mutex.run(msg.channelId, async () => {
    let typingTimer;
    let attachmentPaths = [];
    try {
      await msg.channel.sendTyping();
      typingTimer = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

      const history = await loadHistoryForLlm(msg.channelId);
      await recordUserMessage({ msg, text, attachments });

      const result = await runAgent({ history, userText: text, attachments });
      attachmentPaths = result.attachmentPaths;
      const replyText = result.text || '(no reply)';

      try {
        await recordAgentTurns({
          channelId: msg.channelId,
          guildId: msg.guildId || null,
          threadId: msg.thread?.id || null,
          turns: result.agentMessages,
        });
      } catch (e) {
        logger.error('failed to record agent turns', e);
      }

      clearInterval(typingTimer);
      await sendReply(msg.channel, replyText, attachmentPaths);
    } catch (e) {
      clearInterval(typingTimer);
      logger.error('agent failure', e);
      const replyText = `Sorry — internal error: \`${e.message}\``;
      await sendReply(msg.channel, replyText);
      try {
        await recordAssistantMessage({
          channelId: msg.channelId,
          guildId: msg.guildId || null,
          threadId: msg.thread?.id || null,
          text: replyText,
        });
      } catch (e2) {
        logger.error('failed to record assistant error message', e2);
      }
    } finally {
      await cleanupTmpAttachments(attachmentPaths);
    }
  });
}

async function cleanupTmpAttachments(paths) {
  const tmpRoot = path.resolve(os.tmpdir());
  for (const p of paths || []) {
    try {
      const resolved = path.resolve(p);
      if (!resolved.startsWith(tmpRoot + path.sep)) continue;
      await fsp.unlink(resolved);
    } catch (e) {
      if (e?.code !== 'ENOENT') logger.warn(`failed to delete tmp attachment ${p}: ${e.message}`);
    }
  }
}
