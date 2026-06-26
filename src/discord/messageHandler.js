import { config } from '../config.js';
import { logger } from '../log.js';
import { channelMutex } from '../agent/channelMutex.js';
import { cleanupTmpAttachments } from '../util/tmpFiles.js';
import { runAgent } from '../agent/loop.js';
import { enhancePrompt } from '../agent/promptEnhance.js';
import { trimHistoryForLlm } from '../agent/historyTrim.js';
import {
  loadHistoryForLlm,
  recordUserMessage,
  recordAssistantMessage,
  recordAgentTurns,
} from '../mongo/messages.js';
import {
  getHistoryClearedAt,
  getCurrentProjectId,
  setCurrentProjectId,
} from '../mongo/channelState.js';
import { getDefaultProject, getProjectById } from '../mongo/projects.js';
import { listCharacters } from '../mongo/characters.js';
import { getPlot } from '../mongo/plots.js';
import { recordAnthropicTextUsage } from '../mongo/tokenUsage.js';
import { sendReply } from './reply.js';
import { shouldIgnoreMessage } from './messageFilter.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const STEP_SLOW_MS = 5000;

function fireAndForgetTyping(channel) {
  const t0 = Date.now();
  const watchdog = setTimeout(() => {
    logger.warn(
      `sendTyping background: still pending after ${Date.now() - t0}ms (Discord REST may be wedged)`,
    );
  }, 5000);
  if (watchdog.unref) watchdog.unref();
  channel.sendTyping().then(
    () => {
      clearTimeout(watchdog);
      const elapsed = Date.now() - t0;
      if (elapsed >= 1000) logger.info(`sendTyping background: ok in ${elapsed}ms`);
    },
    (e) => {
      clearTimeout(watchdog);
      const status = e?.status ?? e?.httpStatus ?? '?';
      const code = e?.code ?? '?';
      logger.warn(
        `sendTyping background: failed in ${Date.now() - t0}ms status=${status} code=${code} msg=${e?.message || e}`,
      );
    },
  );
}

async function loggedStep(label, fn, slowMs = STEP_SLOW_MS) {
  const t0 = Date.now();
  logger.info(`step start: ${label}`);
  let warned = false;
  const watchdog = setInterval(() => {
    warned = true;
    logger.warn(`step pending: ${label} (${Date.now() - t0}ms)`);
  }, slowMs);
  if (watchdog.unref) watchdog.unref();
  try {
    const result = await fn();
    clearInterval(watchdog);
    const elapsed = Date.now() - t0;
    if (warned || elapsed >= slowMs) {
      logger.warn(`step done: ${label} ${elapsed}ms (slow)`);
    } else {
      logger.info(`step done: ${label} ${elapsed}ms`);
    }
    return result;
  } catch (e) {
    clearInterval(watchdog);
    logger.warn(`step failed: ${label} after ${Date.now() - t0}ms: ${e.message}`);
    throw e;
  }
}

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

  logger.info(`queueing into channel mutex (channel=${msg.channelId})`);
  const mutexT0 = Date.now();
  await channelMutex.run(msg.channelId, async () => {
    logger.info(`entered channel mutex after ${Date.now() - mutexT0}ms`);
    let typingTimer;
    let attachmentPaths = [];
    let projectId = null;
    let projectTitle = null;
    try {
      fireAndForgetTyping(msg.channel);
      typingTimer = setInterval(() => fireAndForgetTyping(msg.channel), 8000);

      // Resolve the channel's active project (inside the mutex, so a
      // set_project from a concurrent message can never race this read).
      projectId = await loggedStep('mongo getCurrentProjectId', () =>
        getCurrentProjectId(msg.channelId),
      );
      let project = projectId ? await getProjectById(projectId) : null;
      if (!project) {
        project = await getDefaultProject();
        projectId = project._id.toString();
        await setCurrentProjectId(msg.channelId, projectId);
        logger.info(`project pointer initialized → "${project.title}" (${projectId})`);
      }
      projectTitle = project.title;

      const histT0 = Date.now();
      const clearedAt = await loggedStep('mongo getHistoryClearedAt', () =>
        getHistoryClearedAt(msg.channelId),
      );
      const rawHistory = await loggedStep('mongo loadHistoryForLlm', () =>
        loadHistoryForLlm(msg.channelId, {
          maxAgeMs: config.trim.historyWindowMs,
          since: clearedAt,
          minKeptUserTurns: config.trim.minKeptUserTurns,
        }),
      );
      logger.info(`history loaded ${rawHistory.length} msgs (mongo total ${Date.now() - histT0}ms)`);
      const { messages: history, stats: trimStats } = config.trim.enabled
        ? trimHistoryForLlm(rawHistory, {
            tokenBudget: config.trim.tokenBudget,
            summarizeStale: config.trim.summarizeStale,
            minKeptUserTurns: config.trim.minKeptUserTurns,
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

      await loggedStep('mongo recordUserMessage', () =>
        recordUserMessage({ msg, text, attachments, displayName, projectId }),
      );

      const enhanceT0 = Date.now();
      const [characters, plot] = await loggedStep('mongo listCharacters+getPlot', () =>
        Promise.all([listCharacters(projectId), getPlot(projectId)]),
      );
      const enhancement = await loggedStep('anthropic enhancePrompt', () =>
        enhancePrompt({
          userText: text,
          characters,
          beats: plot?.beats || [],
          synopsis: plot?.synopsis || '',
        }),
      );
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
      const result = await loggedStep(
        'agent runAgent',
        () =>
          runAgent({
            history,
            userText: text,
            attachments,
            discordUser,
            channelId: msg.channelId,
            enhancementNotes: enhancement.notes,
            projectId,
            projectTitle,
          }),
        15000,
      );
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
          projectId: result.projectId ?? projectId,
          turns: result.agentMessages,
        });
      } catch (e) {
        logger.error('failed to record agent turns', e);
      }

      clearInterval(typingTimer);
      await loggedStep('discord sendReply', () =>
        sendReply(msg.channel, replyText, attachmentPaths, attachmentLinks),
      );
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
          projectId,
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
