import { connectMongo } from './mongo/client.js';
import { seedDefaults } from './seed/defaults.js';
import { createDiscordClient } from './discord/client.js';
import { startServer } from './server/index.js';
import { logger } from './log.js';

async function main() {
  await connectMongo();
  await seedDefaults();
  startServer();
  const bot = createDiscordClient();
  await bot.start();
  logger.info('screenplay bot online');
}

main().catch((e) => {
  logger.error('fatal startup', e);
  process.exit(1);
});
