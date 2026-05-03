// Handles Discord button interactions for the SPA approval flow.
//
// Buttons are emitted by src/web/auth.js when a user submits the login form.
// custom_id format:  auth:approve:<request_id>  or  auth:deny:<request_id>
//
// On click, this module updates the auth_requests doc, edits the original
// embed to show the resolution, and (for approvals) inserts an auth_sessions
// doc. The browser polling /auth/status will see the new status on its next
// poll.

import { EmbedBuilder } from 'discord.js';
import { logger } from '../log.js';
import { approveAuthRequest, denyAuthRequest } from '../mongo/auth.js';

const APPROVE_RE = /^auth:approve:(.+)$/;
const DENY_RE = /^auth:deny:(.+)$/;

function rebuildEmbed(prev, { decided, deciderTag, color }) {
  const builder = EmbedBuilder.from(prev);
  builder.setColor(color);
  builder.setDescription(`${prev.description ?? ''}\n\n**${decided} by ${deciderTag}**`.trim());
  return builder;
}

async function ackResolution(interaction, { kind, deciderTag }) {
  try {
    const message = interaction.message;
    const prev = message.embeds?.[0];
    if (!prev) {
      await interaction.update({ content: `Request ${kind} by ${deciderTag}.`, components: [] });
      return;
    }
    const color = kind === 'approved' ? 0x6acf7e : 0xf06a6a;
    const next = rebuildEmbed(prev.toJSON ? prev.toJSON() : prev, {
      decided: kind === 'approved' ? 'Approved' : 'Denied',
      deciderTag,
      color,
    });
    await interaction.update({ embeds: [next], components: [] });
  } catch (e) {
    logger.warn(`auth interaction ack failed: ${e.message}`);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate();
      }
    } catch {}
  }
}

async function ackAlreadyDecided(interaction, request) {
  try {
    await interaction.reply({
      content: `Already ${request?.status || 'decided'}.`,
      ephemeral: true,
    });
  } catch (e) {
    logger.warn(`auth interaction ack-already failed: ${e.message}`);
  }
}

export function installInteractionHandlers(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton?.()) return;
    const id = interaction.customId || '';
    const approveMatch = id.match(APPROVE_RE);
    const denyMatch = id.match(DENY_RE);
    if (!approveMatch && !denyMatch) return;

    const requestId = (approveMatch || denyMatch)[1];
    const deciderTag = interaction.user?.tag || interaction.user?.username || 'unknown';
    const deciderId = interaction.user?.id || null;

    try {
      if (approveMatch) {
        const { result, request } = await approveAuthRequest({
          requestId,
          deciderTag,
          deciderId,
        });
        if (result === 'approved') {
          await ackResolution(interaction, { kind: 'approved', deciderTag });
        } else if (result === 'already_decided') {
          await ackAlreadyDecided(interaction, request);
        } else {
          await interaction.reply({ content: 'Request not found or expired.', ephemeral: true });
        }
      } else {
        const { result, request } = await denyAuthRequest({
          requestId,
          deciderTag,
          deciderId,
        });
        if (result === 'denied') {
          await ackResolution(interaction, { kind: 'denied', deciderTag });
        } else if (result === 'already_decided') {
          await ackAlreadyDecided(interaction, request);
        } else {
          await interaction.reply({ content: 'Request not found or expired.', ephemeral: true });
        }
      }
    } catch (e) {
      logger.error(`auth interaction failure (${id})`, e);
      try {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `Error: ${e.message}`, ephemeral: true });
        }
      } catch {}
    }
  });
}
