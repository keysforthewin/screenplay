import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../log.js';
import { TOOLS, CORE_TOOL_NAMES, toolDefsForApi } from './tools.js';
import { searchTools } from './toolSearch.js';
import { dispatchTool } from './handlers.js';
import {
  recordEntityTouch,
  resolveEntityLinks,
  appendEntityLinks,
  createTouchedEntities,
  clearTouchedEntities,
} from './entityLinks.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { detectReviewIntent, reviewInterceptText } from './reviewMode.js';
import { getBotDisplayName } from '../web/gateway.js';
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

const MAX_TOOL_ITERATIONS = 32;

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
  'revise_',
  'generate_image',
];

function isMutatingTool(name) {
  if (!name) return false;
  return MUTATING_PREFIXES.some((p) => name === p || name.startsWith(p));
}

// Wrap an array of API-shaped tool definitions with a cache_control breakpoint
// on the last entry, when caching is enabled. The input array is not mutated.
function withToolsCache(tools) {
  if (!config.cache.enabled || !tools.length) return tools;
  const last = tools[tools.length - 1];
  const ttl = config.cache.toolsTtl;
  const cache_control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
  return [...tools.slice(0, -1), { ...last, cache_control }];
}

function buildToolSearchResultText(query, matches, alreadyLoaded) {
  if (!matches.length) {
    return `No tools matched "${query}". Try a different phrasing or a category name (characters, beats, director_notes, images, attachments, plot, export, tmdb, web_search, analysis).`;
  }
  const fresh = matches.filter((n) => !alreadyLoaded.has(n));
  const parts = [
    `Loaded ${matches.length} tool${matches.length === 1 ? '' : 's'}: ${matches.join(', ')}.`,
  ];
  if (fresh.length < matches.length) {
    parts.push(`(${matches.length - fresh.length} were already available.)`);
  }
  parts.push('They are now in your tools list — call them directly.');
  return parts.join(' ');
}

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

async function buildSystem({
  omitDirectorNotes = false,
  cache = config.cache.enabled,
  senderName = null,
  reviewMode = false,
  projectId = null,
  projectTitle = null,
} = {}) {
  const [characters, characterTemplate, plotTemplate, plot, directorNotes] =
    await Promise.all([
      listCharacters(projectId),
      getCharacterTemplate(projectId),
      getPlotTemplate(projectId),
      getPlot(projectId),
      getDirectorNotes(projectId),
    ]);
  return buildSystemPrompt({
    characters,
    characterTemplate,
    plotTemplate,
    plot,
    directorNotes: omitDirectorNotes ? null : directorNotes,
    cache,
    systemTtl: config.cache.systemTtl,
    botName: getBotDisplayName(),
    senderName,
    reviewMode,
    projectTitle,
  });
}

const ENHANCEMENT_PREAMBLE =
  '[Interpretive notes from prompt pre-processor — these are hints, not ' +
  'authoritative. The user text above is the source of truth.]';

export function buildUserContent(
  userText,
  attachments,
  enhancementNotes = null,
  senderName = null,
  pageContext = null,
) {
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
  // Prefix the message body with [senderName] so the live message uses the same
  // attribution shape as historical messages (see docToLlmMessage). Without
  // this, the most recent labeled history message wins the "who is 'I'?"
  // attention and the bot misidentifies the current speaker.
  const speaker =
    typeof senderName === 'string' && senderName.trim() ? senderName.trim() : null;
  const label = (s) => (speaker ? `[${speaker}] ${s}` : s);
  if (sections.length) {
    const prelude = sections.join('\n\n');
    text = text ? `${prelude}\n\n${label(text)}` : `${prelude}\n\n${label('(no message)')}`;
  } else if (text) {
    text = label(text);
  }
  content.push({ type: 'text', text });
  if (typeof pageContext === 'string' && pageContext.trim()) {
    content.push({ type: 'text', text: pageContext.trim() });
  }
  if (typeof enhancementNotes === 'string' && enhancementNotes.trim()) {
    content.push({
      type: 'text',
      text: `${ENHANCEMENT_PREAMBLE}\n\n${enhancementNotes.trim()}`,
    });
  }
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
      // Handlers report failure by returning a string starting with "Tool error ("
      // (canonical prefix produced by dispatchTool's catch in handlers.js, and
      // by handler-internal validation paths). dispatchFn never throws those —
      // it only throws for truly unexpected failures. Tag the tool_result with
      // is_error: true so the model treats it as a hard failure (per Anthropic
      // protocol) instead of a normal response that invites a destructive
      // fallback. Also log the content so bot logs aren't opaque.
      const isHandlerError =
        typeof result === 'string' &&
        (result.startsWith('Tool error (') || result.startsWith('Unknown tool: '));
      if (isHandlerError) {
        logger.warn(`tool failed ${tu.name}: ${result}`);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
          is_error: true,
        });
      } else {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
      }
    } catch (e) {
      // Defense in depth: dispatchTool already catches handler errors, but if anything
      // here throws (interceptAttachment, future code) we MUST still emit a tool_result
      // for this tool_use_id, otherwise the next Anthropic request 400s.
      logger.error(`tool dispatch failed ${tu.name}: ${e.message}\n${e.stack || ''}`);
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
  enhancementNotes = null,
  projectId = null,
  projectTitle = null,
  onEvent = null,
  webRun = false,
  pageContext = null,
}) {
  // Optional progress hook (web chat uses it to surface tool activity). A
  // throwing listener must never break the agent run.
  const emit = (ev) => {
    try {
      onEvent?.(ev);
    } catch {}
  };
  const senderName =
    typeof discordUser?.displayName === 'string' && discordUser.displayName.trim()
      ? discordUser.displayName.trim()
      : null;
  const reviewMode = detectReviewIntent(userText);
  if (reviewMode) {
    logger.info('agent → review-mode active for this turn (mutations will be intercepted)');
  }
  const messages = [
    ...history,
    {
      role: 'user',
      content: buildUserContent(userText, attachments, enhancementNotes, senderName, pageContext),
    },
  ];
  const agentStart = messages.length;
  const attachmentPaths = [];
  const attachmentLinks = [];
  const touchedEntities = createTouchedEntities();
  const context = { discordUser, channelId, projectId, projectTitle, webRun };
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

  // Tools loaded for this turn. Starts with the core set (always-available
  // read-only inspection tools + tool_search). The model expands it mid-turn
  // by calling tool_search, which is intercepted in the iteration loop and
  // mutates this set directly.
  const loadedToolNames = new Set(CORE_TOOL_NAMES);

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
    let cachedSystem = await buildSystem({
      senderName,
      reviewMode,
      projectId: context.projectId,
      projectTitle: context.projectTitle,
    });
    let systemDirty = false;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (systemDirty) {
        cachedSystem = await buildSystem({
          senderName,
          reviewMode,
          projectId: context.projectId,
          projectTitle: context.projectTitle,
        });
        systemDirty = false;
      }
      const system = cachedSystem;
      logger.debug(`agent iteration ${i}, ${messages.length} messages`);

      const currentTools = withToolsCache(toolDefsForApi(loadedToolNames));

      if (i === 0) {
        const systemNoDirectorNotes = await buildSystem({
          omitDirectorNotes: true,
          senderName,
          reviewMode,
          projectId: context.projectId,
          projectTitle: context.projectTitle,
        });
        sectionTokensPromise = measureSectionTokens({
          model,
          system,
          systemNoDirectorNotes,
          tools: currentTools,
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
        `anthropic → iter ${i + 1}/${MAX_TOOL_ITERATIONS} model=${model} msgs=${messages.length} tools=${currentTools.length}`,
      );
      emit({ type: 'iteration', n: i + 1, max: MAX_TOOL_ITERATIONS });
      const anthropicT0 = Date.now();
      // Stream rather than use the non-streaming create(): the SDK rejects a
      // non-streaming request whose worst-case generation could exceed 10
      // minutes, which max_tokens=16000 trips on models with an 8192
      // non-streaming cap (the Opus 4 family). We don't consume token deltas —
      // finalMessage() returns the same Message shape create() would have.
      const resp = await client.messages
        .stream({
          model,
          max_tokens: config.anthropic.maxTokens,
          system,
          tools: currentTools,
          messages: requestMessages,
        })
        .finalMessage();
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
        const entityUrls = await resolveEntityLinks(touchedEntities, context);
        const finalText = appendEntityLinks(text, entityUrls);
        return {
          text: finalText,
          attachmentPaths,
          attachmentLinks,
          projectId: context.projectId,
          agentMessages: messages.slice(agentStart),
        };
      }

      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      emit({ type: 'tools', tools: toolUses.map((t) => t.name) });

      // Split out tool_search (handled inline so it can mutate loadedToolNames),
      // and — when review-mode is active — intercept any mutation tool call so
      // its handler never runs. Everything else goes through normal dispatch.
      const metaResults = [];
      const blockedResults = [];
      const realToolUses = [];
      for (const tu of toolUses) {
        if (tu.name === 'tool_search') {
          const query = tu.input?.query ?? '';
          const limit = tu.input?.limit;
          const alreadyLoaded = new Set(loadedToolNames);
          const matches = searchTools(query, {
            limit: typeof limit === 'number' ? limit : 8,
            exclude: new Set(['tool_search']),
          });
          for (const n of matches) loadedToolNames.add(n);
          const content = buildToolSearchResultText(query, matches, alreadyLoaded);
          logger.info(`tool_search "${query}" → ${matches.length} match(es): ${matches.join(', ') || '-'}`);
          metaResults.push({ type: 'tool_result', tool_use_id: tu.id, content });
          if (toolStats instanceof Map) {
            const slot = toolStats.get('tool_search') || { count: 0, result_tokens: 0 };
            slot.count += 1;
            slot.result_tokens += Math.ceil(content.length / 4);
            toolStats.set('tool_search', slot);
          }
        } else if (reviewMode && isMutatingTool(tu.name)) {
          const content = reviewInterceptText(tu.name);
          logger.info(`review-mode → blocked mutation tool '${tu.name}'`);
          blockedResults.push({ type: 'tool_result', tool_use_id: tu.id, content });
          if (toolStats instanceof Map) {
            const slot = toolStats.get(tu.name) || { count: 0, result_tokens: 0 };
            slot.count += 1;
            slot.result_tokens += Math.ceil(content.length / 4);
            toolStats.set(tu.name, slot);
          }
        } else {
          realToolUses.push(tu);
        }
      }

      // Snapshot project before the batch so we can detect a successful
      // set_project by context mutation rather than by result error flags
      // (handlers may return a friendly error string — not is_error — on
      // failure, which the old error-flag check would misread as success).
      const projectBefore = context.projectId;

      const realResults = realToolUses.length
        ? await dispatchToolUses(
            realToolUses,
            attachmentPaths,
            context,
            dispatchTool,
            toolStats,
            attachmentLinks,
          )
        : [];

      // A successful set_project mutates context.projectId in place. That
      // mutation is the semantic event we key on — it is more reliable than
      // inspecting result error flags, which don't distinguish a friendly-
      // error string (per handler conventions) from a real success.
      //
      // When a switch did happen we must also record touches in batch order so
      // that tools BEFORE the switch are cleared and tools AFTER the switch are
      // kept against the new project. Order matters because a ref like "beat 3"
      // or a character name can exist in both projects — clearing after the
      // whole batch would wrongly keep pre-switch touches, and clearing before
      // recording would drop post-switch touches.
      if (context.projectId !== projectBefore) {
        // Find the split point: the first set_project tool is the one that
        // mutated context (set_project is the only tool that changes projectId).
        const splitIdx = realToolUses.findIndex((tu) => tu.name === 'set_project');
        // Record touches for tools BEFORE the switch (pre-switch project).
        for (let i = 0; i < splitIdx; i++) {
          recordEntityTouch(realToolUses[i].name, realToolUses[i].input, touchedEntities);
        }
        // Clear all pre-switch refs — they belong to the old project and must
        // not be resolved as links in the new one (order-number refs like "beat
        // 3" and name refs can resolve to entirely different entities in the new
        // project, not just fail as not-found).
        const dropped =
          touchedEntities.beats.size +
          touchedEntities.characters.size +
          (touchedEntities.notes ? 1 : 0);
        if (dropped) {
          logger.info(`set_project: dropped ${dropped} pre-switch touched entity ref(s)`);
        }
        clearTouchedEntities(touchedEntities);
        // Record touches for the set_project tool and everything after it —
        // these resolve against the new project at end of turn.
        for (let i = splitIdx; i < realToolUses.length; i++) {
          recordEntityTouch(realToolUses[i].name, realToolUses[i].input, touchedEntities);
        }
      } else {
        // No project switch — record all touches in one pass as before.
        for (const tu of realToolUses) {
          recordEntityTouch(tu.name, tu.input, touchedEntities);
        }
      }

      // Reassemble in the original tool_use order so tool_result blocks line up.
      const resultById = new Map();
      for (const r of metaResults) resultById.set(r.tool_use_id, r);
      for (const r of blockedResults) resultById.set(r.tool_use_id, r);
      for (const r of realResults) resultById.set(r.tool_use_id, r);
      const results = toolUses.map((tu) => resultById.get(tu.id));
      messages.push({ role: 'user', content: results });

      // Only flip systemDirty for mutations that actually ran. Blocked mutations
      // changed nothing in Mongo, so the cached system prompt is still accurate.
      if (realToolUses.some((tu) => isMutatingTool(tu.name))) {
        systemDirty = true;
      }
    }

    logger.warn(`max iterations hit (${MAX_TOOL_ITERATIONS}) — returning fallback`);
    const entityUrls = await resolveEntityLinks(touchedEntities, context);
    const finalText = appendEntityLinks('(Agent hit max tool iterations.)', entityUrls);
    return {
      text: finalText,
      attachmentPaths,
      attachmentLinks,
      projectId: context.projectId,
      agentMessages: messages.slice(agentStart),
    };
  } finally {
    await persistUsage();
  }
}
