import { connectMongo } from './mongo/client.js';
import { seedDefaults } from './seed/defaults.js';
import { createDiscordClient } from './discord/client.js';
import { startServer } from './server/index.js';
import { installLifecycleHandlers } from './lifecycle.js';
import { startBackupScheduler } from './backup/scheduler.js';
import { logger } from './log.js';

async function main() {
  await connectMongo();
  await seedDefaults();
  await startBackupScheduler();
  startServer();
  const bot = createDiscordClient();
  await bot.start();
  installLifecycleHandlers(bot.client);
  logger.info('screenplay bot online');
}

main().catch((e) => {
  logger.error('fatal startup', e);
  process.exit(1);
});
