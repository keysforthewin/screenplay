import { statSync } from 'node:fs';
import { AttachmentBuilder } from 'discord.js';
import { pdfLink } from '../server/index.js';
import { logger } from '../log.js';

const MAX_LEN = 1900;

// Effective per-message attachment cap. Discord rejects with 40005 above this.
// Default 24 MB stays safely under the 25 MB cap on non-boosted guilds; can be
// raised via env on guilds with higher boost tiers.
const DEFAULT_DISCORD_ATTACHMENT_LIMIT = 24 * 1024 * 1024;

export function partitionAttachableFiles(files, limitBytes) {
  const limit = Number.isFinite(limitBytes)
    ? limitBytes
    : Number(process.env.DISCORD_ATTACHMENT_LIMIT_BYTES) || DEFAULT_DISCORD_ATTACHMENT_LIMIT;
  const attachable = [];
  const oversized = [];
  let total = 0;
  for (const p of files || []) {
    let size;
    try {
      size = statSync(p).size;
    } catch (e) {
      logger.warn(`attach: stat failed for ${p}: ${e.message}`);
      continue;
    }
    if (total + size > limit) {
      oversized.push({ path: p, size });
    } else {
      attachable.push(p);
      total += size;
    }
  }
  return { attachable, oversized };
}

export function chunk(text) {
  if (!text) return [];
  const out = [];
  let rest = text;
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf('\n', MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

function buildLinkFooter(files, extraLinks) {
  const all = [];
  for (const f of files || []) {
    const link = pdfLink(f);
    if (link) all.push(link);
  }
  for (const link of extraLinks || []) {
    if (link) all.push(link);
  }
  if (!all.length) return null;
  if (all.length === 1) return `File link: ${all[0]}`;
  return `File links:\n${all.map((l) => `- ${l}`).join('\n')}`;
}

export async function sendReply(channel, text, files = [], links = []) {
  const { attachable, oversized } = partitionAttachableFiles(files);
  for (const o of oversized) {
    logger.warn(
      `attach: skipping ${o.path} (${o.size} bytes > Discord limit) — link-only fallback`,
    );
  }
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const attachments = isLast ? attachable.map((f) => new AttachmentBuilder(f)) : [];
    await channel.send({ content: parts[i] || '​', files: attachments });
  }
  if (!parts.length && attachable.length) {
    await channel.send({ files: attachable.map((f) => new AttachmentBuilder(f)) });
  }
  const linkMsg = buildLinkFooter(files, links);
  if (linkMsg) {
    await channel.send({ content: linkMsg });
  }
}
