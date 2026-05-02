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

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildOversizedNotice(oversized) {
  if (!oversized || !oversized.length) return null;
  if (oversized.length === 1) {
    const o = oversized[0];
    const link = pdfLink(o.path);
    if (link) {
      return `Note: the file is too large to attach to Discord (${formatMb(o.size)}). Download it here: ${link}`;
    }
    return `Note: a file (${formatMb(o.size)}) was too large to attach and no fallback download link is available.`;
  }
  const lines = oversized.map((o) => {
    const link = pdfLink(o.path);
    return link
      ? `- ${link} (${formatMb(o.size)})`
      : `- (${formatMb(o.size)} — no fallback link available)`;
  });
  return `Note: some files were too large to attach to Discord. Download them here:\n${lines.join('\n')}`;
}

function statSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function isTooLargeError(e) {
  // Discord's "Request entity too large" error code.
  return e?.code === 40005 || e?.status === 413 || e?.httpStatus === 413;
}

async function sendWithFallback(channel, content, attachPaths) {
  const attachments = attachPaths.map((f) => new AttachmentBuilder(f));
  try {
    await channel.send({ content: content || '​', files: attachments });
    return { rejected: [] };
  } catch (e) {
    if (!isTooLargeError(e) || attachPaths.length === 0) throw e;
    logger.warn(
      `Discord rejected ${attachPaths.length} attachment(s) with 40005 — retrying with link-only fallback`,
    );
    const rejectedInfos = attachPaths.map((p) => ({ path: p, size: statSize(p) }));
    const rejectionNotice = buildOversizedNotice(rejectedInfos);
    const fallbackContent = rejectionNotice
      ? content
        ? `${content}\n\n${rejectionNotice}`
        : rejectionNotice
      : content;
    await channel.send({ content: fallbackContent || '​', files: [] });
    return { rejected: attachPaths };
  }
}

export async function sendReply(channel, text, files = [], links = []) {
  const { attachable, oversized } = partitionAttachableFiles(files);
  for (const o of oversized) {
    logger.warn(
      `attach: skipping ${o.path} (${o.size} bytes > Discord limit) — link-only fallback`,
    );
  }
  const notice = buildOversizedNotice(oversized);
  const finalText = notice ? (text ? `${text}\n\n${notice}` : notice) : text;
  const parts = chunk(finalText);
  // Files whose link was already surfaced via a fallback notice (pre-flight
  // oversize or 40005 retry) — exclude from the trailing link footer.
  const fallbackLinkedPaths = new Set(oversized.map((o) => o.path));
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const attachThisChunk = isLast ? attachable : [];
    const { rejected } = await sendWithFallback(channel, parts[i], attachThisChunk);
    for (const p of rejected) fallbackLinkedPaths.add(p);
  }
  if (!parts.length && attachable.length) {
    const { rejected } = await sendWithFallback(channel, '', attachable);
    for (const p of rejected) fallbackLinkedPaths.add(p);
  }
  const footerFiles = files.filter((f) => !fallbackLinkedPaths.has(f));
  const linkMsg = buildLinkFooter(footerFiles, links);
  if (linkMsg) {
    await channel.send({ content: linkMsg });
  }
}
