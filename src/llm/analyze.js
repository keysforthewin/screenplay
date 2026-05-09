import { config } from '../config.js';
import { getAnthropic } from '../anthropic/client.js';

export async function analyzeText({ system, user, model, maxTokens } = {}) {
  if (!user || typeof user !== 'string' || !user.trim()) {
    throw new Error('analyzeText requires a non-empty user string.');
  }
  const client = getAnthropic();
  const resp = await client.messages.create({
    model: model || config.anthropic.model,
    max_tokens: maxTokens || 2048,
    system: system || undefined,
    messages: [{ role: 'user', content: user }],
  });
  return (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
