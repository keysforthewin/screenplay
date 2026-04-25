import { config } from '../config.js';
import { logger } from '../log.js';
import { keyedMutex } from '../util/mutex.js';
import { runAgent } from '../agent/loop.js';
import { loadHistory, saveHistory } from '../mongo/conversations.js';
import { sendReply } from './reply.js';

const mutex = keyedMutex();

export async function handleMessage(msg) {
  if (msg.author.bot) return;
  if (msg.channelId !== config.discord.movieChannelId) return;
  const text = msg.content?.trim();
  if (!text) return;

  await mutex.run(msg.channelId, async () => {
    let typingTimer;
    try {
      await msg.channel.sendTyping();
      typingTimer = setInterval(() => msg.channel.sendTyping().catch(() => {}), 8000);

      const history = await loadHistory(msg.channelId);
      const { messages, text: replyText, pdfPaths } = await runAgent({ history, userText: text });
      await saveHistory(msg.channelId, messages);

      clearInterval(typingTimer);
      await sendReply(msg.channel, replyText || '(no reply)', pdfPaths);
    } catch (e) {
      clearInterval(typingTimer);
      logger.error('agent failure', e);
      await sendReply(msg.channel, `Sorry — internal error: \`${e.message}\``);
    }
  });
}
