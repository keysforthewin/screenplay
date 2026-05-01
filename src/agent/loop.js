import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../log.js';
import { TOOLS } from './tools.js';
import { dispatchTool } from './handlers.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { withMessageCacheBreakpoint } from './historyCache.js';
import { listCharacters } from '../mongo/characters.js';
import { getCharacterTemplate, getPlotTemplate } from '../mongo/prompts.js';
import { getDirectorNotes } from '../mongo/directorNotes.js';
import { getPlot } from '../mongo/plots.js';
import { fetchImageFromUrl } from '../mongo/imageBytes.js';
import { imageLink, attachmentLink } from '../server/index.js';
import { computeAnthropicImageTokens } from './imageTokens.js';
import {
  recordAnthropicTextUsage,
  recordAnthropicImageInputUsage,
} from '../mongo/tokenUsage.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const MAX_TOOL_ITERATIONS = 12;

// Tool-name prefixes (or whole names) that mutate state visible in the volatile
// system block (characters list, beats list, current beat, director notes).
// When any tool with one of these prefixes runs in an iteration, the cached
// system prompt is invalidated so the next iteration rebuilds it from Mongo.
const MUTATING_PREFIXES = [
  'create_',
  'update_',
  'delete_',
  'add_',
  'remove_',
  'edit_',
  'set_',
  'clear_',
  'link_',
  'unlink_',
  'attach_',
  'append_',
  'reorder_',
  'bulk_',
  'generate_image',
];

function isMutatingTool(name) {
  if (!name) return false;
  return MUTATING_PREFIXES.some((p) => name === p || name.startsWith(p));
}

// Module-level: clone TOOLS once with cache_control on the last tool. Do NOT
// mutate the original TOOLS array — tests/tools-schema.test.js inspects it.
const TOOLS_CACHED = (() => {
  if (!config.cache.enabled || !TOOLS.length) return TOOLS;
  const last = TOOLS[TOOLS.length - 1];
  const ttl = config.cache.toolsTtl;
  const cache_control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
  return [...TOOLS.slice(0, -1), { ...last, cache_control }];
})();

const SECTION_PAD_MESSAGES = [{ role: 'user', content: 'x' }];

function stripImageBlocks(message) {
  if (!message || !Array.isArray(message.content)) return message;
  const filtered = message.content.filter((b) => b && b.type !== 'image');
  return {
    ...message,
    content: filtered.length ? filtered : [{ type: 'text', text: '' }],
  };
}

export async function measureSectionTokens({
  model,
  system,
  systemNoDirectorNotes,
  tools,
  messages,
}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const lastUser = stripImageBlocks(messages[messages.length - 1]);
  const historyMsgs = messages.slice(0, -1);
  const [baseline, sysC, sysNoNotesC, toolsC, userC, histC] = await Promise.all([
    client.messages.countTokens({ model, messages: SECTION_PAD_MESSAGES }),
    client.messages.countTokens({ model, system, messages: SECTION_PAD_MESSAGES }),
    client.messages.countTokens({
      model,
      system: systemNoDirectorNotes,
      messages: SECTION_PAD_MESSAGES,
    }),
    client.messages.countTokens({ model, tools, messages: SECTION_PAD_MESSAGES }),
    client.messages.countTokens({ model, messages: [lastUser] }),
    historyMsgs.length
      ? client.messages.countTokens({ model, messages: historyMsgs })
      : Promise.resolve({ input_tokens: 0 }),
  ]);
  const b = Number(baseline?.input_tokens) || 0;
  const sub = (c) => Math.max(0, (Number(c?.input_tokens) || 0) - b);
  const sysWith = sub(sysC);
  const sysWithout = sub(sysNoNotesC);
  return {
    system: sysWithout,
    director_notes: Math.max(0, sysWith - sysWithout),
    tools: sub(toolsC),
    user_input: sub(userC),
    message_history: historyMsgs.length ? sub(histC) : 0,
  };
}

async function buildSystem({ omitDirectorNotes = false, cache = config.cache.enabled } = {}) {
  const [characters, characterTemplate, plotTemplate, plot, directorNotes] =
    await Promise.all([
      listCharacters(),
      getCharacterTemplate(),
      getPlotTemplate(),
      getPlot(),
      getDirectorNotes(),
    ]);
  return buildSystemPrompt({
    characters,
    characterTemplate,
    plotTemplate,
    plot,
    directorNotes: omitDirectorNotes ? null : directorNotes,
    cache,
  });
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

// JSON.stringify on a tool_result content array would dump the entire base64
// image payload (multi-MB) into logs. Render image blocks as a stub instead.
function summarizeToolResultForLog(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const parts = result.map((b) => {
      if (!b || typeof b !== 'object') return String(b ?? '');
      if (b.type === 'text') return String(b.text ?? '');
      if (b.type === 'image') return '[image bytes elided from log]';
      return JSON.stringify(b);
    });
    return parts.join('\n');
  }
  return JSON.stringify(result ?? '');
}

export async function dispatchToolUses(
  toolUses,
  attachmentPaths,
  context = null,
  dispatchFn = dispatchTool,
  toolStats = null,
  attachmentLinks = null,
) {
  const results = [];
  for (const tu of toolUses) {
    logger.info(`tool_use: ${tu.name}`);
    const toolT0 = Date.now();
    let resultText = '';
    try {
      const raw = await dispatchFn(tu.name, tu.input, context);
      const result = interceptAttachment(raw, attachmentPaths, attachmentLinks);
      resultText = summarizeToolResultForLog(result);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    } catch (e) {
      // Defense in depth: dispatchTool already catches handler errors, but if anything
      // here throws (interceptAttachment, future code) we MUST still emit a tool_result
      // for this tool_use_id, otherwise the next Anthropic request 400s.
      logger.warn(`tool dispatch failed ${tu.name}: ${e.message}`);
      const errMsg = `Tool error (${tu.name}): ${e.message}`;
      resultText = errMsg;
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: errMsg,
        is_error: true,
      });
    }
    logger.info(`tool_done: ${tu.name} ${Date.now() - toolT0}ms`);
    if (toolStats instanceof Map) {
      const slot = toolStats.get(tu.name) || { count: 0, result_tokens: 0 };
      slot.count += 1;
      slot.result_tokens += Math.ceil(resultText.length / 4);
      toolStats.set(tu.name, slot);
    }
  }
  return results;
}

const HEX24_RE = /^[a-f0-9]{24}$/i;

// Parses a sentinel payload of the form:
//   <path>
//   <path>|<note>
//   <path>|<note>|<id>           (id = 24-hex GridFS file id)
// Note may itself contain '|' characters, so we look at the LAST segment and
// only treat it as an id if it matches HEX24_RE; otherwise the whole rest is
// note text.
function parsePayload(rest) {
  const firstSep = rest.indexOf('|');
  if (firstSep < 0) return { path: rest, note: '', id: null };
  const path = rest.slice(0, firstSep);
  const tail = rest.slice(firstSep + 1);
  const lastSep = tail.lastIndexOf('|');
  if (lastSep < 0) return { path, note: tail, id: null };
  const candidate = tail.slice(lastSep + 1);
  if (HEX24_RE.test(candidate)) {
    return { path, note: tail.slice(0, lastSep), id: candidate };
  }
  return { path, note: tail, id: null };
}

function pushLink(attachmentLinks, link) {
  if (link && Array.isArray(attachmentLinks)) attachmentLinks.push(link);
}

function interceptAttachment(result, attachmentPaths, attachmentLinks = null) {
  if (typeof result !== 'string') return result;
  if (result.startsWith('__PDF_PATH__:')) {
    attachmentPaths.push(result.slice('__PDF_PATH__:'.length));
    return 'PDF generated and queued for upload.';
  }
  if (result.startsWith('__IMAGE_PATH__:')) {
    const { path: filepath, note, id } = parsePayload(
      result.slice('__IMAGE_PATH__:'.length),
    );
    attachmentPaths.push(filepath);
    pushLink(attachmentLinks, imageLink(id));
    return note || 'Image queued for upload.';
  }
  if (result.startsWith('__IMAGE_PATHS__:')) {
    // Format: <paths_tab_separated>|<note>|<ids_tab_separated>
    // (Old form without ids still works — last segment must be hex24 to count.)
    const rest = result.slice('__IMAGE_PATHS__:'.length);
    const firstSep = rest.indexOf('|');
    let pathsPart = rest;
    let note = '';
    let idsPart = '';
    if (firstSep >= 0) {
      pathsPart = rest.slice(0, firstSep);
      const tail = rest.slice(firstSep + 1);
      const lastSep = tail.lastIndexOf('|');
      if (lastSep >= 0) {
        const candidate = tail.slice(lastSep + 1);
        const ids = candidate.split('\t');
        if (ids.length && ids.every((x) => HEX24_RE.test(x))) {
          idsPart = candidate;
          note = tail.slice(0, lastSep);
        } else {
          note = tail;
        }
      } else {
        note = tail;
      }
    }
    const paths = pathsPart.split('\t').filter(Boolean);
    for (const p of paths) attachmentPaths.push(p);
    if (idsPart) {
      const ids = idsPart.split('\t');
      for (const id of ids) pushLink(attachmentLinks, imageLink(id));
    }
    return note || 'Images queued for upload.';
  }
  if (result.startsWith('__ATTACHMENT_PATH__:')) {
    const { path: filepath, note, id } = parsePayload(
      result.slice('__ATTACHMENT_PATH__:'.length),
    );
    attachmentPaths.push(filepath);
    pushLink(attachmentLinks, attachmentLink(id));
    return note || 'File queued for upload.';
  }
  if (result.startsWith('__CSV_PATH__:')) {
    const { path: filepath, note } = parsePayload(
      result.slice('__CSV_PATH__:'.length),
    );
    attachmentPaths.push(filepath);
    return note || 'CSV generated and queued for upload.';
  }
  return result;
}

async function computeImageInputTokensForAttachments(attachments) {
  const imageAttachments = (attachments || []).filter((a) => a.kind === 'image');
  if (!imageAttachments.length) return { perImageTokens: [], total: 0 };
  const buffers = [];
  for (const a of imageAttachments) {
    try {
      const { buffer } = await fetchImageFromUrl(a.url);
      buffers.push(buffer);
    } catch (e) {
      logger.warn(`image-token fetch failed for ${a.url}: ${e.message}`);
      buffers.push(null);
    }
  }
  return computeAnthropicImageTokens(buffers);
}

export async function runAgent({
  history,
  userText,
  attachments = [],
  discordUser = null,
  channelId = null,
}) {
  const messages = [
    ...history,
    { role: 'user', content: buildUserContent(userText, attachments) },
  ];
  const agentStart = messages.length;
  const attachmentPaths = [];
  const attachmentLinks = [];
  const context = { discordUser, channelId };
  const model = config.anthropic.model;

  const anthropicTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    iteration_count: 0,
  };
  const toolStats = new Map();
  let sectionTokensPromise = null;

  const imageTokenInfo = await computeImageInputTokensForAttachments(attachments);

  const accumulateUsage = (usage) => {
    if (!usage) return;
    anthropicTotals.input_tokens += Number(usage.input_tokens) || 0;
    anthropicTotals.output_tokens += Number(usage.output_tokens) || 0;
    anthropicTotals.cache_creation_input_tokens +=
      Number(usage.cache_creation_input_tokens) || 0;
    anthropicTotals.cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0;
    anthropicTotals.iteration_count += 1;
  };

  const persistUsage = async () => {
    try {
      const adjustedInput = Math.max(
        0,
        anthropicTotals.input_tokens - imageTokenInfo.total,
      );
      const sectionTokens = sectionTokensPromise ? await sectionTokensPromise : null;
      await recordAnthropicTextUsage({
        discordUser,
        channelId,
        model,
        totals: { ...anthropicTotals, input_tokens: adjustedInput },
        toolStats,
        sectionTokens,
      });
      if (imageTokenInfo.total > 0) {
        await recordAnthropicImageInputUsage({
          discordUser,
          channelId,
          model,
          perImageTokens: imageTokenInfo.perImageTokens,
        });
      }
    } catch (e) {
      logger.warn(`token usage persist failed: ${e.message}`);
    }
  };

  try {
    let cachedSystem = await buildSystem();
    let systemDirty = false;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (systemDirty) {
        cachedSystem = await buildSystem();
        systemDirty = false;
      }
      const system = cachedSystem;
      logger.debug(`agent iteration ${i}, ${messages.length} messages`);

      if (i === 0) {
        const systemNoDirectorNotes = await buildSystem({ omitDirectorNotes: true });
        sectionTokensPromise = measureSectionTokens({
          model,
          system,
          systemNoDirectorNotes,
          tools: TOOLS,
          messages,
        }).catch((e) => {
          logger.warn(`section tokens measurement failed: ${e.message}`);
          return null;
        });
      }

      const requestMessages = config.cache.enabled
        ? withMessageCacheBreakpoint(messages)
        : messages;

      logger.info(
        `anthropic → iter ${i + 1}/${MAX_TOOL_ITERATIONS} model=${model} msgs=${messages.length}`,
      );
      const anthropicT0 = Date.now();
      const resp = await client.messages.create({
        model,
        max_tokens: config.anthropic.maxTokens,
        system,
        tools: TOOLS_CACHED,
        messages: requestMessages,
      });
      const anthropicMs = Date.now() - anthropicT0;
      const u = resp.usage || {};
      logger.info(
        `anthropic ← stop=${resp.stop_reason} in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache_r=${u.cache_read_input_tokens || 0} cache_w=${u.cache_creation_input_tokens || 0} ${anthropicMs}ms`,
      );

      accumulateUsage(resp.usage);
      messages.push({ role: 'assistant', content: resp.content });

      if (resp.stop_reason !== 'tool_use') {
        // stop_reason can be 'max_tokens' (truncated mid-call) or 'pause_turn'
        // and still include tool_use blocks in content. We won't dispatch them,
        // so strip them from the recorded turn — otherwise the next history load
        // sees an orphan tool_use and Anthropic 400s on the very next request.
        const hadToolUse = resp.content.some((b) => b.type === 'tool_use');
        const truncated = resp.stop_reason === 'max_tokens';
        if (hadToolUse) {
          const cleaned = resp.content.filter((b) => b.type !== 'tool_use');
          messages[messages.length - 1] = {
            role: 'assistant',
            content: cleaned.length
              ? cleaned
              : [{ type: 'text', text: '(response truncated before completion)' }],
          };
        }
        const finalContent = messages[messages.length - 1].content;
        let text = (Array.isArray(finalContent) ? finalContent : [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (truncated && hadToolUse) {
          text = '(Truncated mid-tool-call. Try again — say "do it" or repeat the request.)';
        } else if (truncated) {
          text = `${text}\n\n(Response truncated — output token limit reached. Ask me to continue.)`.trim();
        }
        return { text, attachmentPaths, attachmentLinks, agentMessages: messages.slice(agentStart) };
      }

      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      const results = await dispatchToolUses(
        toolUses,
        attachmentPaths,
        context,
        dispatchTool,
        toolStats,
        attachmentLinks,
      );
      messages.push({ role: 'user', content: results });

      if (toolUses.some((tu) => isMutatingTool(tu.name))) {
        systemDirty = true;
      }
    }

    logger.warn(`max iterations hit (${MAX_TOOL_ITERATIONS}) — returning fallback`);
    return {
      text: '(Agent hit max tool iterations.)',
      attachmentPaths,
      attachmentLinks,
      agentMessages: messages.slice(agentStart),
    };
  } finally {
    await persistUsage();
  }
}
