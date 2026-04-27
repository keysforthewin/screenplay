import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

export async function analyzeText({ system, user, model, maxTokens } = {}) {
  if (!user || typeof user !== 'string' || !user.trim()) {
    throw new Error('analyzeText requires a non-empty user string.');
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
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
