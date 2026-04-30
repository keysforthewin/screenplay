import { AttachmentBuilder } from 'discord.js';
import { pdfLink } from '../server/index.js';

const MAX_LEN = 1900;

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
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const attachments = isLast ? files.map((f) => new AttachmentBuilder(f)) : [];
    await channel.send({ content: parts[i] || '​', files: attachments });
  }
  if (!parts.length && files.length) {
    await channel.send({ files: files.map((f) => new AttachmentBuilder(f)) });
  }
  const linkMsg = buildLinkFooter(files, links);
  if (linkMsg) {
    await channel.send({ content: linkMsg });
  }
}
