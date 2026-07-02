// Posts standalone "someone did X" announcements to the configured movie
// channel when SPA users mutate media (images, audio, video, attachments,
// storyboard frames, artwork). Distinct from sendReply — sendReply replies
// to a user message in the bot's agent loop; this fires unsolicited embeds
// for SPA-initiated work so the channel stays aware of browser activity.
//
// Discord-run agent mutations surface their result via sendReply's
// __IMAGE_PATH__ attachment path, so media announcements are wired into the
// REST endpoints in src/web/entityRoutes.js (and the async job completion
// callbacks). Web-run agent work never reaches Discord via sendReply, so its
// mutations announce from the gateway/editAnnounce layer instead (attributed
// to the web user via runAsEditor): beat create/delete, cast changes, and
// every text edit — see src/web/editAnnounce.js.

import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { imageLink, attachmentLink } from '../server/index.js';

let _client = null;

export function setDiscordClient(client) {
  _client = client;
}

function truncate(s, max) {
  if (!s) return '';
  const str = String(s);
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// Fire-and-forget. Returns a Promise but never rejects; failures are logged.
// All fields except `username` and `verb` are optional.
export async function announceMediaEvent({
  username,
  verb,
  entityLabel,
  entityUrl,
  imageFileId,
  mediaFileId,
  mediaLabel,
  prompt,
  color = 0x4f8cff,
} = {}) {
  try {
    if (!_client) return;
    if (!config.discord.movieChannelId) return;
    const who = username && String(username).trim() ? String(username).trim() : 'Someone';
    const action = verb && String(verb).trim() ? String(verb).trim() : 'changed media';
    const channel = await _client.channels.fetch(config.discord.movieChannelId);
    if (!channel || typeof channel.send !== 'function') return;

    const authorLine = entityLabel ? `${who} ${action} ${entityLabel}` : `${who} ${action}`;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: truncate(authorLine, 240) })
      .setTimestamp(new Date());

    if (entityLabel) embed.setTitle(truncate(entityLabel, 240));
    if (entityUrl) embed.setURL(entityUrl);

    const descParts = [];
    if (prompt) descParts.push(`> ${truncate(prompt, 400)}`);
    if (mediaFileId) {
      const link = attachmentLink(mediaFileId);
      if (link) {
        const label = mediaLabel || 'file';
        descParts.push(`▶ [${label}](${link})`);
      }
    }
    if (descParts.length) embed.setDescription(descParts.join('\n\n'));

    if (imageFileId) {
      const img = imageLink(imageFileId);
      if (img) embed.setImage(img);
    }

    await channel.send({ embeds: [embed] });
  } catch (e) {
    logger.warn(`announceMediaEvent failed: ${e?.message || e}`);
  }
}

// Posts a plain-text status update (no embed). Used for batch summaries.
export async function announceText(text) {
  try {
    if (!_client) return;
    if (!config.discord.movieChannelId) return;
    const channel = await _client.channels.fetch(config.discord.movieChannelId);
    if (!channel?.send) return;
    await channel.send({ content: String(text).slice(0, 1900) });
  } catch (e) {
    logger.warn(`announceText failed: ${e?.message || e}`);
  }
}
