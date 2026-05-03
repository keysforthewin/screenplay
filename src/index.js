import { connectMongo } from './mongo/client.js';
import { ensureAuthIndexes } from './mongo/auth.js';
import { seedDefaults } from './seed/defaults.js';
import { createDiscordClient } from './discord/client.js';
import { installInteractionHandlers } from './discord/interactions.js';
import { startServer } from './server/index.js';
import { installLifecycleHandlers } from './lifecycle.js';
import { startBackupScheduler } from './backup/scheduler.js';
import { startHocuspocus } from './web/hocuspocus.js';
import { bindDiscordClient } from './web/auth.js';
import { setBotDisplayName } from './web/gateway.js';
import { logger } from './log.js';

async function main() {
  await connectMongo();
  await ensureAuthIndexes();
  await seedDefaults();
  await startBackupScheduler();
  startServer();
  await startHocuspocus();
  const bot = createDiscordClient();
  installInteractionHandlers(bot.client);
  bindDiscordClient(bot.client);
  bot.client.once('ready', () => {
    setBotDisplayName(bot.client.user?.displayName || bot.client.user?.username || 'Screenplay Bot');
  });
  await bot.start();
  installLifecycleHandlers(bot.client);
  logger.info('screenplay bot online');
}

main().catch((e) => {
  logger.error('fatal startup', e);
  process.exit(1);
});
