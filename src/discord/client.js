import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { handleMessage } from './messageHandler.js';

export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.once('ready', async () => {
    logger.info(`Discord ready as ${client.user.tag}`);
    try {
      const channel = await client.channels.fetch(config.discord.movieChannelId);
      await channel.send(`🎬 Lucas online (${new Date().toISOString()})`);
    } catch (e) {
      logger.warn(`startup announce failed: ${e.message}`);
    }
  });

  client.on('messageCreate', async (msg) => {
    try {
      await handleMessage(msg);
    } catch (e) {
      logger.error('messageCreate handler crashed', e);
    }
  });

  return {
    client,
    start: async () => client.login(config.discord.token),
  };
}
