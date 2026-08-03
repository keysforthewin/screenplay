// The Fable 5 writer subagent — a mini agent loop spawned by the orchestrator's
// `delegate_writing` tool in two-tier mode. The orchestrator (a cheaper model)
// routes tools and talks to the user; ALL prose lands here, authored by the
// expensive creative model (`config.anthropic.model`).
//
// Design constraints:
// - The writer never sees the Discord conversation. Its whole world is the
//   delegated `task` brief plus what it reads from the project via tools.
// - Static tool surface (WRITER_TOOL_NAMES, no tool_search) so the tools
//   prefix stays byte-identical for the writer's own model-scoped prompt cache.
// - Shares the orchestrator's per-turn `context` object, so the beat-body
//   `load_writing_context` gate and entity-link touches behave exactly as they
//   did when the loop model edited directly.
// - Failures come back as `Tool error (delegate_writing): ...` strings so the
//   orchestrator handles them like any other failed tool call.

import { config } from '../config.js';
import { logger } from '../log.js';
import { getAnthropic } from '../anthropic/client.js';
import { writerToolDefs } from './tools.js';
import { dispatchTool } from './handlers.js';
import { isMutatingTool } from './reviewMode.js';
import { recordEntityTouch } from './entityLinks.js';
import { withMessageCacheBreakpoint } from './historyCache.js';
import { recordAnthropicTextUsage } from '../mongo/tokenUsage.js';
import { SCREENPLAY_STYLE_SUMMARY } from './screenplayStyle.js';
import { formatCasting } from './overview.js';
import { listCharacters } from '../mongo/characters.js';
import { getCharacterTemplate } from '../mongo/prompts.js';
import { getPlot } from '../mongo/plots.js';

const WRITER_MAX_ITERATIONS = 16;

// Plain `edit` is not in MUTATING_PREFIXES (historical loop behavior), but for
// the writer's volatile-block refresh it absolutely counts as a mutation.
const writerMutated = (name) => name === 'edit' || isMutatingTool(name);

// Same shape as loop.js's withToolsCache: breakpoint on the last tool def.
function withToolsCache(tools) {
  if (!config.cache.enabled || !tools.length) return tools;
  const last = tools[tools.length - 1];
  const ttl = config.cache.toolsTtl;
  const cache_control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
  return [...tools.slice(0, -1), { ...last, cache_control }];
}

let stableTextCache = { key: null, text: null };

function buildWriterStableText(characterTemplate) {
  const fieldList = (characterTemplate?.fields || [])
    .map((f) => `- ${f.name}${f.required ? ' [REQUIRED]' : ''}: ${f.description}`)
    .join('\n');
  const key = JSON.stringify(characterTemplate?.fields || []);
  if (stableTextCache.key === key && stableTextCache.text !== null) {
    return stableTextCache.text;
  }

  const text = `You are the **writing specialist** for a collaborative movie screenplay. An orchestrating assistant (which talks to the user) has delegated ONE writing task to you. You cannot see its conversation and you cannot ask the user anything — the task brief plus what you read from the project via tools is everything you get. When the brief is ambiguous, make the best professional call and note it in your report.

# Your job
Execute the delegated task completely: read whatever project state you need, then create/edit the text through your tools. Do the WHOLE task in this session — don't stop after the first entity when the brief names several. Fire independent tool calls (multiple creates, multiple field edits) as parallel tool_use blocks in one turn where possible.

${SCREENPLAY_STYLE_SUMMARY}

# Writing context is mandatory for beat bodies
**Before composing or editing a beat body, you MUST first call \`load_writing_context\`** with the beat and the small subset of characters the passage features (usually 1–5). The \`edit\` tool REJECTS beat-body writes until context for that beat is loaded. This applies to wholesale rewrites, appends, and targeted line edits alike. Beat \`name\`/\`desc\` edits and character/plot/note edits are not gated.

# Editing conventions
Every text mutation goes through \`edit\` (\`{collection, identifier, field, edits: [{find, replace}]}\`):
- Each \`find\` must match the current value VERBATIM and UNIQUELY — add surrounding context to disambiguate. Prefer targeted find/replace over rewrites for long fields.
- Empty \`find\` = whole-field replace; only allowed as a single edit. Use it only for genuine wholesale rewrites.
- To append: read the tail (\`read_beat_body\` / \`read_character_field\` / \`read_director_note\`), then find/replace on the last few characters.
- For bodies too large for context: \`outline_beat_body\` / \`search_in_beat_body\` → \`read_beat_body\` window → \`edit\` with the verbatim snippet.
- **On an \`edit\` error, STOP and re-read the field, then retry with verbatim text. NEVER recover by switching to a wholesale empty-find rewrite** — that destroys the user's work. If it still fails, report the error in your final report instead of forcing the change.

# Character template (the schema every character should satisfy)
${fieldList || '(empty — bootstrap defaults missing)'}

Field values are single human-readable markdown strings — never arrays, objects, or JSON-encoded payloads. Lists become comma-separated text or markdown bullets; multi-part facts become prose.

To fill ONE field across many characters, use \`bulk_update_character_field\` (one call with all values) — don't fan out per-character \`edit\` calls.

# Report contract
Your final message is returned VERBATIM to the orchestrating assistant as your work report. It must be a markdown bullet list — one bullet per change, format \`- <verb> <entity>[: <what changed>]\` (e.g. \`- Created Alice\`, \`- Rewrote 'Diner Morning' body (+840 chars)\`, \`- Appended dialogue sample from Fargo\`). Note any judgment calls or errors as extra bullets. No preamble, no questions, no suggestions.`;

  stableTextCache = { key, text };
  return text;
}

function summarizeBeat(b) {
  const d = (b.desc || '').trim();
  const preview = d.length > 80 ? `${d.slice(0, 79)}…` : d;
  const bodyMark = (b.body || '').trim() ? ' [has body]' : '';
  return `- ${b.order}. ${b.name}${preview ? ` — ${preview}` : ''}${bodyMark}`;
}

function buildWriterVolatileText({ characters, plot, projectTitle }) {
  const charList = characters.length
    ? characters.map((c) => `- ${c.name} (${formatCasting(c)})`).join('\n')
    : '(none yet)';
  const beats = [...(plot?.beats || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const currentBeat = plot?.current_beat_id
    ? beats.find((b) => b._id && plot.current_beat_id.equals(b._id)) || null
    : null;
  const section = (label, value) => {
    const v = (value || '').trim();
    return v ? `\n## ${label}\n${v}\n` : '';
  };
  return `# Current project state
${projectTitle ? `Project: "${projectTitle}". ` : ''}Title: ${plot?.title ? `"${plot.title}"` : '(untitled)'}.
${section('Synopsis', plot?.synopsis)}${section('Global dialogue style', plot?.dialogue_style)}${section('Directorial voice', plot?.directorial_voice)}
Characters on file:
${charList}

Current beat: ${currentBeat ? `"${currentBeat.name}" (order ${currentBeat.order})` : '(none set)'}.
Beats:
${beats.length ? beats.map(summarizeBeat).join('\n') : '(no beats yet)'}`;
}

async function buildWriterSystem(context) {
  const [characters, characterTemplate, plot] = await Promise.all([
    listCharacters(context?.projectId ?? null),
    getCharacterTemplate(context?.projectId ?? null),
    getPlot(context?.projectId ?? null),
  ]);
  const stableBlock = { type: 'text', text: buildWriterStableText(characterTemplate) };
  if (config.cache.enabled) {
    stableBlock.cache_control = config.cache.systemTtl
      ? { type: 'ephemeral', ttl: config.cache.systemTtl }
      : { type: 'ephemeral' };
  }
  const volatileBlock = {
    type: 'text',
    text: buildWriterVolatileText({
      characters,
      plot,
      projectTitle: context?.projectTitle ?? null,
    }),
  };
  return [stableBlock, volatileBlock];
}

const fail = (msg) => ({ ok: false, text: `Tool error (delegate_writing): ${msg}` });

export async function runWriterAgent({
  task,
  beat = null,
  characters = null,
  context = null,
  onEvent = null,
}) {
  if (typeof task !== 'string' || !task.trim()) {
    return fail('missing task brief.');
  }
  const emit = (ev) => {
    try {
      onEvent?.(ev);
    } catch {}
  };

  const client = getAnthropic();
  const model = config.anthropic.model;
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    iteration_count: 0,
  };
  const toolStats = new Map();
  const bumpStat = (name, resultText) => {
    const slot = toolStats.get(name) || { count: 0, result_tokens: 0 };
    slot.count += 1;
    slot.result_tokens += Math.ceil(String(resultText || '').length / 4);
    toolStats.set(name, slot);
  };

  const seedLines = [task.trim()];
  if (typeof beat === 'string' && beat.trim()) seedLines.push(`Target beat: ${beat.trim()}`);
  if (Array.isArray(characters) && characters.length) {
    seedLines.push(`Featured characters: ${characters.join(', ')}`);
  }
  const messages = [
    { role: 'user', content: [{ type: 'text', text: seedLines.join('\n') }] },
  ];
  const tools = withToolsCache(writerToolDefs());

  try {
    let cachedSystem = await buildWriterSystem(context);
    let systemDirty = false;

    for (let i = 0; i < WRITER_MAX_ITERATIONS; i++) {
      if (systemDirty) {
        cachedSystem = await buildWriterSystem(context);
        systemDirty = false;
      }
      const requestMessages = config.cache.enabled
        ? withMessageCacheBreakpoint(messages)
        : messages;

      logger.info(
        `writer → iter ${i + 1}/${WRITER_MAX_ITERATIONS} model=${model} msgs=${messages.length}`,
      );
      const t0 = Date.now();
      // Stream for the same reason loop.js does: the SDK rejects non-streaming
      // requests whose worst-case generation could exceed its timeout.
      const resp = await client.messages
        .stream({
          model,
          max_tokens: config.anthropic.writerMaxTokens,
          system: cachedSystem,
          tools,
          messages: requestMessages,
        })
        .finalMessage();
      const u = resp.usage || {};
      logger.info(
        `writer ← stop=${resp.stop_reason} in=${u.input_tokens || 0} out=${u.output_tokens || 0} ${Date.now() - t0}ms`,
      );
      totals.input_tokens += Number(u.input_tokens) || 0;
      totals.output_tokens += Number(u.output_tokens) || 0;
      totals.cache_creation_input_tokens += Number(u.cache_creation_input_tokens) || 0;
      totals.cache_read_input_tokens += Number(u.cache_read_input_tokens) || 0;
      totals.iteration_count += 1;

      messages.push({ role: 'assistant', content: resp.content });

      if (resp.stop_reason === 'refusal') {
        return fail('the writer declined the task — rephrase or narrow the brief.');
      }

      if (resp.stop_reason !== 'tool_use') {
        const text = (Array.isArray(resp.content) ? resp.content : [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (resp.stop_reason === 'max_tokens') {
          return fail(
            `writer output was truncated (token cap); partial changes may have been applied.${text ? ` Last report: ${text}` : ''}`,
          );
        }
        return { ok: true, text: text || '(writer returned no report)' };
      }

      const toolUses = resp.content.filter((b) => b.type === 'tool_use');
      emit({ type: 'tools', tools: toolUses.map((t) => t.name) });

      const results = [];
      for (const tu of toolUses) {
        logger.info(`writer tool_use: ${tu.name}`);
        let result;
        try {
          result = await dispatchTool(tu.name, tu.input, context);
        } catch (e) {
          logger.error(`writer tool dispatch failed ${tu.name}: ${e.message}`);
          result = `Tool error (${tu.name}): ${e.message}`;
        }
        const isErr =
          typeof result === 'string' &&
          (result.startsWith('Tool error (') || result.startsWith('Unknown tool: '));
        if (isErr) logger.warn(`writer tool failed ${tu.name}: ${result}`);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result,
          ...(isErr ? { is_error: true } : {}),
        });
        bumpStat(tu.name, typeof result === 'string' ? result : '');
        recordEntityTouch(tu.name, tu.input, context?.touchedEntities);
        if (!isErr && writerMutated(tu.name)) systemDirty = true;
      }
      messages.push({ role: 'user', content: results });
    }

    logger.warn(`writer hit max iterations (${WRITER_MAX_ITERATIONS})`);
    return fail(
      'writer hit the iteration cap; partial changes may have been applied — check the project state before retrying.',
    );
  } catch (e) {
    logger.error(`writer agent failed: ${e.message}`);
    return fail(e.message);
  } finally {
    try {
      await recordAnthropicTextUsage({
        discordUser: context?.discordUser ?? null,
        channelId: context?.channelId ?? null,
        model,
        totals,
        toolStats,
      });
    } catch (e) {
      logger.warn(`writer token usage persist failed: ${e.message}`);
    }
  }
}
