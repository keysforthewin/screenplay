import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { handleMessage } from './messageHandler.js';
import { registerSlashCommands } from './interactions.js';
import { setBotDisplayName } from '../web/gateway.js';
import { getCurrentProjectId } from '../mongo/channelState.js';
import { getDefaultProject, getProjectById } from '../mongo/projects.js';

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
    await registerSlashCommands(client);
    try {
      const channel = await client.channels.fetch(config.discord.movieChannelId);
      let resolvedName =
        client.user.displayName || client.user.username || 'Screenplay Bot';
      try {
        const me = await channel.guild?.members.fetch(client.user.id);
        if (me?.displayName) resolvedName = me.displayName;
      } catch (e) {
        logger.warn(`could not resolve guild nickname: ${e.message}`);
      }
      setBotDisplayName(resolvedName);
      logger.info(`bot display name: ${resolvedName}`);
      let project = null;
      try {
        const projectId = await getCurrentProjectId(config.discord.movieChannelId);
        project = projectId ? await getProjectById(projectId) : null;
        if (!project) project = await getDefaultProject();
      } catch (e) {
        logger.warn(`startup project lookup failed: ${e.message}`);
      }
      const projectNote = project ? ` — project "${project.title}"` : '';
      await channel.send(`🎬 Lucas online${projectNote} (${new Date().toISOString()})`);
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
