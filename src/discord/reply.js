import { AttachmentBuilder } from 'discord.js';

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

export async function sendReply(channel, text, files = []) {
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const attachments = isLast ? files.map((f) => new AttachmentBuilder(f)) : [];
    await channel.send({ content: parts[i] || '​', files: attachments });
  }
  if (!parts.length && files.length) {
    await channel.send({ files: files.map((f) => new AttachmentBuilder(f)) });
  }
}
