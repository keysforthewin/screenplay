import { analyzeText } from './analyze.js';
import { stripMarkdown } from '../util/markdown.js';

const SYSTEM = `You write one-sentence summaries of film storyboard shots. The user gives you the full prompt for one shot; reply with a single plain sentence in the present tense describing what happens visually. It is shown as a card caption, so keep it scan-length and skip camera jargon unless it is load-bearing. Plain text only — no markdown or quotes.`;

export async function summarizeStoryboardPrompt(textPrompt) {
  const cleaned = stripMarkdown(String(textPrompt || '')).trim();
  if (!cleaned) throw new Error('text_prompt is empty');
  const out = await analyzeText({
    system: SYSTEM,
    user: cleaned,
    // Thinking is billed against max_tokens on Fable 5; the sentence itself is ~25 tokens.
    maxTokens: 2000,
  });
  const summary = String(out || '').replace(/\s+/g, ' ').trim();
  if (!summary) throw new Error('summary came back empty');
  return summary;
}
