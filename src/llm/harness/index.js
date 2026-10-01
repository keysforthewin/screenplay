// Coding-agent harness provider: answers Messages-API requests whose `model`
// is an encoded harness id (`claude-code:<model>:<effort>` / `codex:…`, see
// src/llm/modelSlots.js) by running one Claude Code / Codex turn and mapping
// the answer back to an Anthropic Message. The routing client in
// src/anthropic/client.js is the only caller; every feature reaches this
// through getAnthropic().messages.create|stream unchanged.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config.js';
import { logger } from '../../log.js';
import { fetchImageFromUrl } from '../../mongo/imageBytes.js';
import { isHarnessModelId, parseHarnessModel } from '../modelSlots.js';
import { buildHarnessTurn, mapHarnessAnswer, toMessage } from './translate.js';
import { runClaudeCode } from './claudeCode.js';
import { runCodex } from './codex.js';

export class HarnessDisabledError extends Error {
  constructor() {
    super('Coding-agent providers (Claude Code / Codex) are disabled on this server — set LLM_HARNESS_ENABLED=1 (dev only) or pick an API model in Admin → Models.');
    this.name = 'HarnessDisabledError';
  }
}

export function isHarnessEnabled() {
  return config.llmHarness.enabled;
}

export { isHarnessModelId };

let runners = { 'claude-code': runClaudeCode, codex: runCodex };
// Test seam: replace the provider runners ({ 'claude-code'?, codex? }).
export function _setHarnessRunnersForTests(next) {
  runners = next ? { 'claude-code': runClaudeCode, codex: runCodex, ...next } : { 'claude-code': runClaudeCode, codex: runCodex };
}

// Each call spawns a CLI process; cap how many run at once so a bulk job
// (dialog for every beat, start-frame planning) cannot fork dozens.
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= Math.max(1, config.llmHarness.concurrency)) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

// Image sources → bytes on disk (Codex takes paths) + base64 (Claude takes
// content blocks). URL sources go through the usual validated download.
async function materializeImages(sources, dir) {
  const out = [];
  for (const [i, src] of sources.entries()) {
    let buffer;
    let mediaType;
    if (src?.type === 'base64') {
      buffer = Buffer.from(src.data, 'base64');
      mediaType = src.media_type;
    } else if (src?.type === 'url') {
      const r = await fetchImageFromUrl(src.url);
      buffer = r.buffer;
      mediaType = r.contentType;
    } else {
      continue;
    }
    const p = path.join(dir, `image-${i + 1}.${EXT[mediaType] || 'png'}`);
    await fs.writeFile(p, buffer);
    out.push({ path: p, mediaType, base64: buffer.toString('base64') });
  }
  return out;
}

function addUsage(total, u) {
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    total[k] = (total[k] || 0) + (Number(u?.[k]) || 0);
  }
  if (u?.cost_usd != null) total.cost_usd = (total.cost_usd || 0) + Number(u.cost_usd);
  return total;
}

// messages.create() equivalent. One retry when the answer does not map
// (bad JSON / unknown tool), with the problem fed back as a correction.
export async function harnessCreate(params, { signal } = {}) {
  if (!isHarnessEnabled()) throw new HarnessDisabledError();
  const target = parseHarnessModel(params.model);
  if (!target) throw new Error(`not a harness model id: ${params.model}`);
  const run = runners[target.provider];
  const label = target.provider === 'codex' ? 'Codex' : 'Claude Code';
  return withSlot(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-harness-'));
    try {
      let correction = null;
      const usage = {};
      for (let attempt = 0; attempt < 2; attempt++) {
        const turn = buildHarnessTurn(params, { includeSystem: target.provider === 'codex', correction });
        const images = await materializeImages(turn.images, dir);
        const t0 = Date.now();
        const { answer, usage: u } = await run({ ...turn, images, model: target.model, effort: target.effort, signal });
        addUsage(usage, u);
        logger.info(
          `harness ← ${params.model} mode=${turn.mode} in=${Number(u?.input_tokens) || 0} out=${Number(u?.output_tokens) || 0} ${Date.now() - t0}ms`,
        );
        const mapped = mapHarnessAnswer(params, turn.mode, answer);
        if (!mapped.error) return toMessage({ model: params.model, ...mapped, usage });
        logger.warn(`harness: ${label} answer did not map (${mapped.error})${attempt ? '' : ' — retrying'}`);
        correction = `Your previous answer was rejected: ${mapped.error}`;
      }
      // Second miss: hand back whatever text there is rather than failing the caller.
      return toMessage({ model: params.model, content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage });
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

// messages.stream() equivalent: the subset the app uses — on('inputJson'|
// 'text'|'message'|'error'), finalMessage(), done(), abort(). No incremental
// deltas: listeners fire once with the final content.
export function harnessStream(params) {
  const listeners = new Map();
  const ac = new AbortController();
  const emit = (ev, ...args) => (listeners.get(ev) || []).forEach((fn) => fn(...args));
  const promise = harnessCreate(params, { signal: ac.signal }).then(
    (msg) => {
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) emit('text', b.text, b.text);
        if (b.type === 'tool_use') {
          const json = JSON.stringify(b.input);
          emit('inputJson', json, b.input);
        }
      }
      emit('message', msg);
      emit('end');
      return msg;
    },
    (err) => {
      emit('error', err);
      throw err;
    },
  );
  promise.catch(() => {}); // surfaced through finalMessage()/done()
  const stream = {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return stream;
    },
    finalMessage: () => promise,
    done: () => promise.then(() => undefined),
    abort: () => ac.abort(),
    controller: ac,
  };
  return stream;
}
