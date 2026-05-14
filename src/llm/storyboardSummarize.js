import { analyzeText } from './analyze.js';
import { stripMarkdown } from '../util/markdown.js';

const SYSTEM = `You write extremely concise one-sentence summaries of film storyboard shots. The user gives you the full prompt for one shot; you return ONE plain sentence (no markdown, no quotes, no preamble) of at most 20 words that captures what happens visually. Present tense. No camera-direction jargon unless it's load-bearing.`;

export async function summarizeStoryboardPrompt(textPrompt) {
  const cleaned = stripMarkdown(String(textPrompt || '')).trim();
  if (!cleaned) throw new Error('text_prompt is empty');
  const out = await analyzeText({
    system: SYSTEM,
    user: cleaned,
    maxTokens: 120,
  });
  return String(out || '').replace(/\s+/g, ' ').trim();
}
