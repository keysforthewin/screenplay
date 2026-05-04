import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../log.js';
import { keyedMutex } from '../util/mutex.js';
import { runAgent } from '../agent/loop.js';
import { enhancePrompt } from '../agent/promptEnhance.js';
import { trimHistoryForLlm } from '../agent/historyTrim.js';
import {
  loadHistoryForLlm,
  recordUserMessage,
  recordAssistantMessage,
  recordAgentTurns,
} from '../mongo/messages.js';
import { getHistoryClearedAt } from '../mongo/channelState.js';
import { listCharacters } from '../mongo/characters.js';
import { getPlot } from '../mongo/plots.js';
import { recordAnthropicTextUsage } from '../mongo/tokenUsage.js';
import { sendReply } from './reply.js';
import { shouldIgnoreMessage } from './messageFilter.js';

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
  if (await shouldIgnoreMessage(msg, msg.client.user.id)) {
    logger.debug(`ignoring human-to-human message from ${msg.author.tag}`);
    return;
  }
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

      const clearedAt = await getHistoryClearedAt(msg.channelId);
      const rawHistory = await loadHistoryForLlm(msg.channelId, {
        maxAgeMs: config.trim.historyWindowMs,
        since: clearedAt,
      });
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
      const displayName =
        msg.member?.displayName ?? msg.author.globalName ?? msg.author.username;
      const discordUser = { id: msg.author.id, displayName };

      await recordUserMessage({ msg, text, attachments, displayName });

      const enhanceT0 = Date.now();
      const [characters, plot] = await Promise.all([listCharacters(), getPlot()]);
      const enhancement = await enhancePrompt({
        userText: text,
        characters,
        beats: plot?.beats || [],
        synopsis: plot?.synopsis || '',
      });
      if (enhancement.usage) {
        try {
          await recordAnthropicTextUsage({
            discordUser,
            channelId: msg.channelId,
            model: config.anthropic.enhancerModel,
            totals: {
              input_tokens: enhancement.usage.input_tokens || 0,
              output_tokens: enhancement.usage.output_tokens || 0,
              cache_creation_input_tokens:
                enhancement.usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: enhancement.usage.cache_read_input_tokens || 0,
              iteration_count: 1,
            },
          });
        } catch (e) {
          logger.warn(`enhancer usage record failed: ${e.message}`);
        }
      }
      logger.info(
        `prompt-enhancer ${Date.now() - enhanceT0}ms notes=${enhancement.notes ? 'yes' : 'no'} summary=${enhancement.summary ? 'yes' : 'no'}`,
      );

      const agentT0 = Date.now();
      const result = await runAgent({
        history,
        userText: text,
        attachments,
        discordUser,
        channelId: msg.channelId,
        enhancementNotes: enhancement.notes,
      });
      attachmentPaths = result.attachmentPaths;
      const attachmentLinks = result.attachmentLinks || [];
      const baseReplyText = result.text || '(no reply)';
      const replyText = enhancement.summary
        ? `${baseReplyText}\n\n> _Interpreted: ${enhancement.summary}_`
        : baseReplyText;
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
