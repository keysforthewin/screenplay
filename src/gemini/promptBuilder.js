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

// Standing production rule appended to every composed prompt: text is a
// post-production layer, so generated images are the clean plates it lands on.
// Stated positively ("blank", "unlettered") because naming a thing plants it.
//
// Unlike the storyboard / plate / character-sheet pipelines, this tool serves
// ad-hoc operator requests, so an explicit ask for specific wording still wins
// — otherwise "generate a poster that says OPEN" would fight its own prompt.
export const NO_TEXT_RULE =
  'Text is added in post-production, so this image carries none unless the request above explicitly asks for specific wording: ' +
  'render signs, marquees, screens, banners, and covers as blank, unlettered surfaces, and add no captions, titles, labels, or watermarks.';

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

  sections.push(NO_TEXT_RULE);

  return sections.join('\n\n');
}
