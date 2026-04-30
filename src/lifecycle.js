import { config } from './config.js';
import { logger } from './log.js';
import { closeMongo } from './mongo/client.js';

const ANNOUNCE_TIMEOUT_MS = 3000;

function formatErrorBlock(err) {
  if (!err) return '';
  const msg = err.message ? String(err.message) : String(err);
  const stack = typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : '';
  const body = stack || msg;
  const trimmed = body.length > 1500 ? `${body.slice(0, 1500)}…` : body;
  return `\n\`\`\`\n${trimmed}\n\`\`\``;
}

async function announceWithTimeout(client, content) {
  const send = (async () => {
    const channel = await client.channels.fetch(config.discord.movieChannelId);
    await channel.send(content);
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('discord announce timed out')), ANNOUNCE_TIMEOUT_MS);
  });
  try {
    await Promise.race([send, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function installLifecycleHandlers(client) {
  let shuttingDown = false;

  async function shutdown(prefix, err, exitCode) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (err) logger.error(prefix, err);
    else logger.info(prefix);

    const body = `${prefix}${formatErrorBlock(err)}`;
    try {
      await announceWithTimeout(client, body);
    } catch (e) {
      logger.warn(`lifecycle announce failed: ${e.message}`);
    }

    try {
      await closeMongo();
    } catch (e) {
      logger.warn(`mongo close failed during shutdown: ${e.message}`);
    }

    try {
      client.destroy();
    } catch (e) {
      logger.warn(`discord destroy failed: ${e.message}`);
    }

    process.exit(exitCode);
  }

  process.on('uncaughtException', (err) => {
    shutdown('💥 Lucas crashed (uncaughtException)', err, 1);
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    shutdown('💥 Lucas crashed (unhandledRejection)', err, 1);
  });
  process.on('SIGTERM', () => {
    shutdown('👋 Lucas shutting down (SIGTERM)', null, 0);
  });
  process.on('SIGINT', () => {
    shutdown('👋 Lucas shutting down (SIGINT)', null, 0);
  });

  logger.info('lifecycle handlers installed');
}
