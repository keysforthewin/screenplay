import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../log.js';
import { TOOLS } from './tools.js';
import { dispatchTool } from './handlers.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { listCharacters } from '../mongo/characters.js';
import { getCharacterTemplate, getPlotTemplate } from '../mongo/prompts.js';
import { getPlot } from '../mongo/plots.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const MAX_TOOL_ITERATIONS = 12;

async function buildSystem() {
  const [characters, characterTemplate, plotTemplate, plot] = await Promise.all([
    listCharacters(),
    getCharacterTemplate(),
    getPlotTemplate(),
    getPlot(),
  ]);
  return buildSystemPrompt({ characters, characterTemplate, plotTemplate, plot });
}

function buildUserContent(userText, attachments) {
  const content = [];
  const images = attachments.filter((a) => a.kind !== 'file');
  const files = attachments.filter((a) => a.kind === 'file');
  for (const a of images) {
    content.push({ type: 'image', source: { type: 'url', url: a.url } });
  }
  let text = userText || '';
  const sections = [];
  if (images.length) {
    const lines = images.map(
      (a) => `- ${a.filename} (${a.contentType}, ${a.size} bytes) at ${a.url}`,
    );
    sections.push(`Attached images:\n${lines.join('\n')}`);
  }
  if (files.length) {
    const lines = files.map(
      (a) => `- ${a.filename} (${a.contentType || 'unknown'}, ${a.size} bytes) at ${a.url}`,
    );
    sections.push(`Attached files:\n${lines.join('\n')}`);
  }
  if (sections.length) {
    const prelude = sections.join('\n\n');
    text = text ? `${prelude}\n\n${text}` : `${prelude}\n\n(no message)`;
  }
  content.push({ type: 'text', text });
  return content;
}

export async function dispatchToolUses(toolUses, attachmentPaths, dispatchFn = dispatchTool) {
  const results = [];
  for (const tu of toolUses) {
    logger.info(`tool_use: ${tu.name}`);
    try {
      const raw = await dispatchFn(tu.name, tu.input);
      const result = interceptAttachment(raw, attachmentPaths);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    } catch (e) {
      // Defense in depth: dispatchTool already catches handler errors, but if anything
      // here throws (interceptAttachment, future code) we MUST still emit a tool_result
      // for this tool_use_id, otherwise the next Anthropic request 400s.
      logger.warn(`tool dispatch failed ${tu.name}: ${e.message}`);
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: `Tool error (${tu.name}): ${e.message}`,
        is_error: true,
      });
    }
  }
  return results;
}

function interceptAttachment(result, attachmentPaths) {
  if (typeof result !== 'string') return result;
  if (result.startsWith('__PDF_PATH__:')) {
    attachmentPaths.push(result.slice('__PDF_PATH__:'.length));
    return 'PDF generated and queued for upload.';
  }
  if (result.startsWith('__IMAGE_PATH__:')) {
    const rest = result.slice('__IMAGE_PATH__:'.length);
    const sep = rest.indexOf('|');
    const filepath = sep >= 0 ? rest.slice(0, sep) : rest;
    const note = sep >= 0 ? rest.slice(sep + 1) : '';
    attachmentPaths.push(filepath);
    return note || 'Image queued for upload.';
  }
  return result;
}

export async function runAgent({ history, userText, attachments = [] }) {
  const messages = [
    ...history,
    { role: 'user', content: buildUserContent(userText, attachments) },
  ];
  const agentStart = messages.length;
  const attachmentPaths = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const system = await buildSystem();
    logger.debug(`agent iteration ${i}, ${messages.length} messages`);

    const resp = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      // stop_reason can be 'max_tokens' (truncated mid-call) or 'pause_turn'
      // and still include tool_use blocks in content. We won't dispatch them,
      // so strip them from the recorded turn — otherwise the next history load
      // sees an orphan tool_use and Anthropic 400s on the very next request.
      if (resp.content.some((b) => b.type === 'tool_use')) {
        const cleaned = resp.content.filter((b) => b.type !== 'tool_use');
        messages[messages.length - 1] = {
          role: 'assistant',
          content: cleaned.length
            ? cleaned
            : [{ type: 'text', text: '(response truncated before completion)' }],
        };
      }
      const finalContent = messages[messages.length - 1].content;
      const text = (Array.isArray(finalContent) ? finalContent : [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text, attachmentPaths, agentMessages: messages.slice(agentStart) };
    }

    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    const results = await dispatchToolUses(toolUses, attachmentPaths);
    messages.push({ role: 'user', content: results });
  }

  return {
    text: '(Agent hit max tool iterations.)',
    attachmentPaths,
    agentMessages: messages.slice(agentStart),
  };
}
