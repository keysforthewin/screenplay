// Claude Code via @anthropic-ai/claude-agent-sdk. One fresh session per call
// (persisted like any CLI session, so it shows up in the host's history),
// loading the host's user + project settings (skills, plugins, MCP servers,
// hooks) from the mounted ~/.claude. Full tool access: the session runs with
// bypassPermissions.

import { config } from '../../config.js';

// ANTHROPIC_API_KEY would make Claude Code bill the API key the bot itself
// uses instead of the mounted subscription login — strip it (and the other
// overrides that would redirect auth) from the child's environment.
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE'];

export function claudeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) out[k] = v;
  }
  return out;
}

async function* singleUserMessage(content) {
  yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

// turn: { prompt, system, schema, images:[{mediaType, base64}] } → { answer, usage }
export async function runClaudeCode({ prompt, system, schema, images, model, effort, signal }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const content = [
    { type: 'text', text: prompt },
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })),
  ];
  const abortController = new AbortController();
  if (signal) signal.addEventListener('abort', () => abortController.abort(), { once: true });
  const options = {
    cwd: config.llmHarness.cwd,
    env: claudeEnv(),
    settingSources: ['user', 'project'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: system
      ? { type: 'preset', preset: 'claude_code', append: `\n\n# Application system prompt\n\n${system}` }
      : { type: 'preset', preset: 'claude_code' },
    maxTurns: 40,
    abortController,
    stderr: () => {},
  };
  if (model) options.model = model;
  if (effort) options.effort = effort;
  if (schema) options.outputFormat = { type: 'json_schema', schema };

  let result = null;
  for await (const msg of query({ prompt: singleUserMessage(content), options })) {
    if (msg.type === 'result') result = msg;
  }
  if (!result) throw new Error('Claude Code returned no result');
  if (result.is_error || result.subtype !== 'success') {
    const detail = (result.errors || []).join('; ') || result.result || result.subtype;
    throw new Error(`Claude Code failed: ${detail}`);
  }
  const u = result.usage || {};
  return {
    answer: schema ? (result.structured_output ?? result.result) : result.result,
    usage: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cost_usd: result.total_cost_usd,
    },
  };
}
