import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import { keyedMutex } from '../util/mutex.js';
import { runAgent } from '../agent/loop.js';
import { trimHistoryForLlm } from '../agent/historyTrim.js';
import {
  loadHistoryForLlm,
  recordUserMessage,
  recordAssistantMessage,
  recordAgentTurns,
} from '../mongo/messages.js';
import { sendReply } from './reply.js';

const mutex = keyedMutex();

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function extractAttachments(msg) {
  return [...msg.attachments.values()].map((a) => ({
    url: a.url,
    filename: a.name,
    contentType: a.contentType || 'application/octet-stream',
    size: a.size,
    kind: ALLOWED_IMAGE_TYPES.has(a.contentType) ? 'image' : 'file',
  }));
}

export async function handleMessage(msg) {
  if (msg.author.bot) return;
  if (msg.channelId !== config.discord.movieChannelId) return;
  const text = msg.content?.trim() || '';
  const attachments = extractAttachments(msg);
  if (!text && !attachments.length) return;

  const oneLine = text.replace(/\s+/g, ' ').trim();
  const preview = oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine;
  logger.info(
    `discord msg ← ${msg.author.tag} chars=${text.length} attach=${attachments.length}: "${preview}"`,
  );

  await mutex.run(msg.channelId, async () => {
    let typingTimer;
    let attachmentPaths = [];
    try {
      await msg.channel.sendTyping();
      logger.debug('typing started');
      typingTimer = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

      const rawHistory = await loadHistoryForLlm(msg.channelId);
      logger.info(`history loaded ${rawHistory.length} msgs`);
      const { messages: history, stats: trimStats } = config.trim.enabled
        ? trimHistoryForLlm(rawHistory, {
            tokenBudget: config.trim.tokenBudget,
            summarizeStale: config.trim.summarizeStale,
          })
        : { messages: rawHistory, stats: { tokensBefore: 0, tokensAfter: 0, summarized: 0, budgetCut: 0 } };
      if (config.trim.enabled) {
        logger.info(
          `history trimmed: in=${rawHistory.length} out=${history.length} ` +
            `summarized=${trimStats.summarized} budget_cut=${trimStats.budgetCut} ` +
            `tokens_before≈${trimStats.tokensBefore} after≈${trimStats.tokensAfter}`,
        );
      }
      await recordUserMessage({ msg, text, attachments });

      const displayName =
        msg.member?.displayName ?? msg.author.globalName ?? msg.author.username;
      const discordUser = { id: msg.author.id, displayName };

      const agentT0 = Date.now();
      const result = await runAgent({
        history,
        userText: text,
        attachments,
        discordUser,
        channelId: msg.channelId,
      });
      attachmentPaths = result.attachmentPaths;
      const attachmentLinks = result.attachmentLinks || [];
      const replyText = result.text || '(no reply)';
      logger.info(
        `agent done in ${Date.now() - agentT0}ms (${result.agentMessages.length} turns, ${attachmentPaths.length} attach, ${attachmentLinks.length} link)`,
      );

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
      await sendReply(msg.channel, replyText, attachmentPaths, attachmentLinks);
      const pdfs = attachmentPaths.filter((p) => /\.pdf$/i.test(p)).length;
      const images = attachmentPaths.length - pdfs;
      logger.info(
        `reply sent chars=${replyText.length} images=${images} pdfs=${pdfs}`,
      );
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
