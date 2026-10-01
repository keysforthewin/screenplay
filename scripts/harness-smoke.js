#!/usr/bin/env node
// Manual live check of the coding-agent providers. Not part of the test suite.
//
//   LLM_HARNESS_ENABLED=1 node scripts/harness-smoke.js [claude-code|codex] [model] [effort]
//   docker compose -f docker-compose.yml -f docker-compose.dev.yml exec bot node scripts/harness-smoke.js codex
//
// Sends three requests through getAnthropic() exactly as the app does — a
// plain text reply, a single-tool call (the shape every generator and the
// agent loop use) and an output_config JSON-schema answer — and prints what
// came back and how long each took. No Mongo involved.

import { getAnthropic } from '../src/anthropic/client.js';
import { encodeHarnessModel } from '../src/llm/modelSlots.js';
import { isHarnessEnabled } from '../src/llm/harness/index.js';

const [provider = 'claude-code', model = null, effort = null] = process.argv.slice(2);

const TOOL = {
  name: 'name_characters',
  description: 'Record names for the characters of a short film.',
  input_schema: {
    type: 'object',
    properties: { names: { type: 'array', items: { type: 'string' } } },
    required: ['names'],
  },
};

const FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: { title: { type: 'string' }, runtime_minutes: { type: 'integer' } },
    required: ['title', 'runtime_minutes'],
    additionalProperties: false,
  },
};

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const msg = await fn();
    console.log(`\n── ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s) stop=${msg.stop_reason} usage=${JSON.stringify(msg.usage)}`);
    for (const b of msg.content) console.log(b.type === 'tool_use' ? `tool_use ${b.name} ${JSON.stringify(b.input)}` : `text: ${b.text}`);
    return true;
  } catch (e) {
    console.error(`\n── ${label} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
    return false;
  }
}

async function main() {
  if (!isHarnessEnabled()) {
    console.error('LLM_HARNESS_ENABLED is not set — nothing to smoke.');
    process.exit(2);
  }
  const id = encodeHarnessModel({ provider, model, effort });
  console.log(`model id: ${id}`);
  const client = getAnthropic();
  const results = [
    await timed('text', () =>
      client.messages.create({
        model: id,
        max_tokens: 1000,
        system: 'You are a terse script consultant.',
        messages: [{ role: 'user', content: 'In one sentence: what makes a cold open work?' }],
      }),
    ),
    await timed('tool', () =>
      client.messages
        .stream({
          model: id,
          max_tokens: 1000,
          tools: [TOOL],
          tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: 'Invent three names for a heist film crew and record them with the tool.' }],
        })
        .finalMessage(),
    ),
    await timed('schema', () =>
      client.messages.create({
        model: id,
        max_tokens: 1000,
        output_config: { format: FORMAT },
        messages: [{ role: 'user', content: 'Propose a title and runtime for a short film about a lighthouse keeper.' }],
      }),
    ),
  ];
  process.exit(results.every(Boolean) ? 0 : 1);
}

main();
