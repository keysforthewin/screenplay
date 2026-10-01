// Messages-API request ⇄ one coding-agent turn (pure — no SDK, no I/O).
//
// A harness (Claude Code / Codex) has no raw tool_use protocol for OUR tools,
// so a request is rendered into a single prompt: the system text, the whole
// conversation as a transcript (tool calls and results included), and — when
// the request carries tools — a manifest plus a strict JSON envelope the
// harness must answer with. The envelope is mapped back to Anthropic content
// blocks so callers (the agent loop, the writer, every single-tool generator)
// cannot tell the difference.

import crypto from 'node:crypto';

// Envelope for tool-bearing requests. `input_json` is a JSON STRING so the
// schema stays strict (Codex's structured output rejects free-form objects).
export const TOOL_ENVELOPE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    text: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          input_json: { type: 'string' },
        },
        required: ['name', 'input_json'],
        additionalProperties: false,
      },
    },
  },
  required: ['text', 'tool_calls'],
  additionalProperties: false,
});

export function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n\n');
  return '';
}

function stringifyResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

// Images become numbered attachments: `[image N]` in the transcript, with the
// source block collected so the provider can attach the bytes.
export function renderTranscript(messages = []) {
  const images = [];
  const parts = [];
  for (const msg of messages) {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content || [];
    const lines = [];
    for (const b of blocks) {
      switch (b?.type) {
        case 'text':
          if (b.text) lines.push(b.text);
          break;
        case 'image':
          images.push(b.source);
          lines.push(`[image ${images.length} attached]`);
          break;
        case 'tool_use':
          lines.push(`[tool call ${b.id}] ${b.name} ${JSON.stringify(b.input ?? {})}`);
          break;
        case 'tool_result':
          lines.push(`[tool result for ${b.tool_use_id}${b.is_error ? ' — ERROR' : ''}]\n${stringifyResultContent(b.content)}`);
          if (Array.isArray(b.content)) {
            for (const c of b.content) {
              if (c?.type === 'image') {
                images.push(c.source);
                lines.push(`[image ${images.length} attached]`);
              }
            }
          }
          break;
        default:
          break; // thinking / redacted blocks carry nothing the harness can use
      }
    }
    parts.push(`<${msg.role}>\n${lines.join('\n\n')}\n</${msg.role}>`);
  }
  return { text: parts.join('\n\n'), images };
}

function toolManifest(tools) {
  return tools
    .map((t) => `### ${t.name}\n${t.description || ''}\nInput JSON schema: ${JSON.stringify(t.input_schema || {})}`)
    .join('\n\n');
}

// What kind of answer the request expects.
export function requestMode(params) {
  if (Array.isArray(params.tools) && params.tools.length) return 'tools';
  if (params.output_config?.format?.type === 'json_schema') return 'schema';
  return 'text';
}

// Build the single prompt + the schema the harness answers with.
// `includeSystem` false when the provider takes the system text separately.
export function buildHarnessTurn(params, { includeSystem = true, correction = null } = {}) {
  const mode = requestMode(params);
  const sys = systemText(params.system);
  const { text: transcript, images } = renderTranscript(params.messages);
  const sections = [
    'You are answering ONE request on behalf of an application that normally calls the Anthropic Messages API. ' +
      'Reply as the assistant would to the conversation below. You may use your own tools and skills to research ' +
      'before answering, but do NOT modify files in this workspace unless the conversation explicitly asks you to.',
  ];
  if (includeSystem && sys) sections.push(`# Application system prompt\n\n${sys}`);
  sections.push(`# Conversation so far\n\n${transcript}`);
  let schema = null;
  if (mode === 'tools') {
    schema = TOOL_ENVELOPE_SCHEMA;
    const choice = params.tool_choice?.type === 'tool' ? ` You MUST call the ${params.tool_choice.name} tool.` : '';
    sections.push(
      `# Application tools\n\nThese are the APPLICATION's tools (not yours). To call any, list them in tool_calls; the application runs them and replies with the results in a later turn.\n\n${toolManifest(params.tools)}`,
      '# Answer format\n\nAnswer with JSON: {"text": "<what the assistant says, may be empty>", "tool_calls": [{"name": "<tool name>", "input_json": "<the tool input as a JSON object, serialized to a string>"}]}. ' +
        `Use an empty tool_calls array when no tool is needed. Each input_json must parse and satisfy that tool's input schema.${choice}`,
    );
  } else if (mode === 'schema') {
    schema = params.output_config.format.schema;
    sections.push(`# Answer format\n\nAnswer with JSON matching this schema: ${JSON.stringify(schema)}`);
  } else {
    sections.push('# Answer format\n\nAnswer with the assistant reply text only.');
  }
  if (correction) sections.push(`# Correction\n\n${correction}`);
  return { mode, prompt: sections.join('\n\n'), system: sys, schema, images };
}

function parseMaybeJson(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const toolUseId = () => `toolu_harness_${crypto.randomBytes(9).toString('hex')}`;

// Harness answer → { content, stop_reason } or { error } (caller retries once
// with the error as a correction note).
export function mapHarnessAnswer(params, mode, answer) {
  if (mode === 'text') {
    return { content: [{ type: 'text', text: String(answer ?? '') }], stop_reason: 'end_turn' };
  }
  if (mode === 'schema') {
    const obj = parseMaybeJson(answer);
    if (!obj) return { error: 'Your answer was not valid JSON. Answer with JSON only.' };
    return { content: [{ type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn' };
  }
  const env = parseMaybeJson(answer);
  if (!env || typeof env !== 'object') return { error: 'Your answer was not the JSON envelope {"text", "tool_calls"}.' };
  const known = new Set(params.tools.map((t) => t.name));
  const content = [];
  if (typeof env.text === 'string' && env.text.trim()) content.push({ type: 'text', text: env.text });
  for (const call of Array.isArray(env.tool_calls) ? env.tool_calls : []) {
    if (!known.has(call?.name)) return { error: `"${call?.name}" is not one of the application tools. Use only: ${[...known].join(', ')}.` };
    const input = call.input && typeof call.input === 'object' ? call.input : parseMaybeJson(call.input_json);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { error: `The input_json for ${call.name} did not parse to a JSON object.` };
    }
    content.push({ type: 'tool_use', id: toolUseId(), name: call.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const calls = content.some((b) => b.type === 'tool_use');
  return { content, stop_reason: calls ? 'tool_use' : 'end_turn' };
}

// Anthropic-shaped Message.
export function toMessage({ model, content, stop_reason, usage }) {
  return {
    id: `msg_harness_${crypto.randomBytes(9).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage?.input_tokens) || 0,
      output_tokens: Number(usage?.output_tokens) || 0,
      cache_creation_input_tokens: Number(usage?.cache_creation_input_tokens) || 0,
      cache_read_input_tokens: Number(usage?.cache_read_input_tokens) || 0,
      ...(usage?.cost_usd != null ? { cost_usd: usage.cost_usd } : {}),
    },
  };
}
