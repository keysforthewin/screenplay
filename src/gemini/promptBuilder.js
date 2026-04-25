function trimText(s, n) {
  if (!s) return '';
  const t = String(s).trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function lineFromMessage(m) {
  if (typeof m.content === 'string') {
    return m.content.trim() ? `${m.role}: ${trimText(m.content, 220)}` : '';
  }
  if (Array.isArray(m.content)) {
    const text = m.content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return text ? `${m.role}: ${trimText(text, 220)}` : '';
  }
  return '';
}

export function summarizeRecentMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  return messages.map(lineFromMessage).filter(Boolean).join('\n');
}

export function buildImagePrompt({ userPrompt, beat, recentMessages } = {}) {
  const sections = [];

  if (userPrompt && String(userPrompt).trim()) {
    sections.push(String(userPrompt).trim());
  }

  if (beat) {
    const lines = [];
    if (beat.name) lines.push(`Scene name: ${beat.name}`);
    if (beat.desc) lines.push(`Summary: ${trimText(beat.desc, 300)}`);
    if (beat.body) lines.push(`Details: ${trimText(beat.body, 700)}`);
    const chars = beat.characters || [];
    if (chars.length) lines.push(`Characters present: ${chars.join(', ')}`);
    if (lines.length) sections.push(`Scene context:\n${lines.join('\n')}`);
  }

  if (recentMessages && recentMessages.length) {
    const summary = summarizeRecentMessages(recentMessages);
    if (summary) sections.push(`Recent conversation:\n${summary}`);
  }

  if (!sections.length) {
    throw new Error(
      'No prompt content. Provide at least one of: userPrompt, beat, recentMessages.',
    );
  }

  return sections.join('\n\n');
}
