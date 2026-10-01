// Codex via @openai/codex-sdk (it spawns the bundled `codex exec`). One fresh
// thread per call, reading the host's mounted ~/.codex (login, config.toml,
// skills, MCP servers). Full access: danger-full-access sandbox, no approvals.

import { config } from '../../config.js';

// An API key in the environment would bill it instead of the mounted ChatGPT
// login — strip it from the child's environment.
const STRIPPED_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'];

export function codexEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) out[k] = v;
  }
  return out;
}

// turn: { prompt, system, schema, images:[{path}] } → { answer, usage }
// Codex has no separate system prompt input; buildHarnessTurn inlines it.
export async function runCodex({ prompt, schema, images, model, effort, signal }) {
  const { Codex } = await import('@openai/codex-sdk');
  const codex = new Codex({ env: codexEnv() });
  const threadOptions = {
    workingDirectory: config.llmHarness.cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    networkAccessEnabled: true,
  };
  if (model) threadOptions.model = model;
  if (effort) threadOptions.modelReasoningEffort = effort;
  const thread = codex.startThread(threadOptions);
  const input = images.length
    ? [{ type: 'text', text: prompt }, ...images.map((img) => ({ type: 'local_image', path: img.path }))]
    : prompt;
  const turn = await thread.run(input, { ...(schema ? { outputSchema: schema } : {}), ...(signal ? { signal } : {}) });
  const u = turn.usage || {};
  return {
    answer: turn.finalResponse,
    usage: {
      input_tokens: u.input_tokens,
      output_tokens: (Number(u.output_tokens) || 0) + (Number(u.reasoning_output_tokens) || 0),
      cache_read_input_tokens: u.cached_input_tokens,
      cache_creation_input_tokens: u.cache_write_input_tokens,
    },
  };
}
