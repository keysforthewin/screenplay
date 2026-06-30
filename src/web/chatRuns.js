// Web chat runs: invoke the same agent loop the Discord bot uses, scoped to
// the project open in the browser. Triggered from POST /api/chat, which
// returns a run id immediately; the SPA opens an EventSource on
// /api/chat/:runId/events and receives progress pushes as the agent works.
//
// Each web user gets an isolated conversation keyed by a synthetic channel id
// (web:<projectId>:<username>, see chatHistory.js), separate from Discord and
// from other users. Runs for the same user+project serialize through the
// channelMutex on that synthetic id; different users never block each other.
// Web runs never touch channel_state — the project is the browser's, for this
// run only — and set_project is refused via the webRun context flag.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../log.js';
import { channelMutex } from '../agent/channelMutex.js';
import { cleanupTmpAttachments } from '../util/tmpFiles.js';
import { runAgent } from '../agent/loop.js';
import { enhancePrompt } from '../agent/promptEnhance.js';
import { trimHistoryForLlm } from '../agent/historyTrim.js';
import {
  loadHistoryForLlm,
  recordUserMessage,
  recordAssistantMessage,
  recordAgentTurns,
} from '../mongo/messages.js';
import { getHistoryClearedAt } from '../mongo/channelState.js';
import { listCharacters } from '../mongo/characters.js';
import { getPlot } from '../mongo/plots.js';
import { recordAnthropicTextUsage } from '../mongo/tokenUsage.js';
import { pdfLink } from '../server/index.js';
import { resolvePageContextNote } from './pageContext.js';
import { webChannelId, computeHistoryStats } from './chatHistory.js';
import { runAsEditor } from './editAttribution.js';

const runs = new Map();      // runId -> run (live mutable object)
const listeners = new Map(); // runId -> Set<(snapshot) => void>

// Keep terminal runs around so a reconnecting EventSource still gets the
// final state via its snapshot.
const TERMINAL_RETENTION_MS = 15 * 60 * 1000;

export function getChatRun(runId) {
  return runs.get(runId) || null;
}

export function subscribeToChatRun(runId, cb) {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(cb);
}

export function unsubscribeFromChatRun(runId, cb) {
  const set = listeners.get(runId);
  if (!set) return;
  set.delete(cb);
  if (!set.size) listeners.delete(runId);
}

export function serializeChatRun(run) {
  if (!run) return null;
  return {
    run_id: run.run_id,
    project_id: run.project_id,
    status: run.status,
    progress: run.progress.slice(),
    text: run.text,
    interpreted: run.interpreted,
    attachments: run.attachments.slice(),
    error: run.error,
    created_at: run.created_at,
    finished_at: run.finished_at,
    estimated_tokens: run.estimated_tokens ?? null,
    last_input_tokens: run.last_input_tokens ?? null,
  };
}

function publish(run) {
  const set = listeners.get(run.run_id);
  if (!set || !set.size) return;
  const snap = serializeChatRun(run);
  for (const cb of set) {
    try {
      cb(snap);
    } catch (e) {
      logger.warn(`chat run: listener threw: ${e.message}`);
    }
  }
}

function scheduleRunEviction(runId) {
  setTimeout(() => {
    runs.delete(runId);
    listeners.delete(runId);
  }, TERMINAL_RETENTION_MS).unref?.();
}

function addProgress(run, label) {
  run.progress.push({ label });
  publish(run);
}

// Translate the loop's attachment outputs into renderable entries for the
// SPA. Links collected from sentinels (GridFS-backed) survive cleanup; PDFs
// live in the export dir and are served by filename; anything else is a
// tmp-only file the web surface cannot deliver. A sentinel that carried a
// GridFS id pushes BOTH a tmp path and a link, with no recorded pairing —
// each link "covers" one matching tmp path so the same image isn't also
// reported as unavailable.
function buildWebAttachments(attachmentPaths, attachmentLinks) {
  const out = [];
  let imageLinks = 0;
  let fileLinks = 0;
  for (const url of attachmentLinks || []) {
    if (!url) continue;
    const isImage = url.includes('/image/');
    out.push({ kind: isImage ? 'image' : 'file', url });
    if (isImage) imageLinks += 1;
    else fileLinks += 1;
  }
  for (const p of attachmentPaths || []) {
    if (/\.pdf$/i.test(p)) {
      const url = pdfLink(p);
      if (url) {
        out.push({ kind: 'pdf', url, filename: path.basename(p) });
        continue;
      }
    }
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(p);
    if (isImage && imageLinks > 0) {
      imageLinks -= 1;
      continue;
    }
    if (!isImage && fileLinks > 0) {
      fileLinks -= 1;
      continue;
    }
    out.push({ kind: 'unavailable', filename: path.basename(p) });
  }
  return out;
}

// Create the run and detach the agent turn onto the shared channel mutex.
// Returns the initial snapshot synchronously so the route can answer 202
// and the SPA can open its SSE stream right away.
export function startChatRun({ projectId, projectTitle, session, text, context = null }) {
  const channelId = webChannelId(projectId, session?.username);
  const run = {
    run_id: randomUUID(),
    project_id: projectId,
    status: 'queued',
    progress: [],
    text: null,
    interpreted: null,
    attachments: [],
    error: null,
    created_at: new Date(),
    finished_at: null,
    estimated_tokens: null,
    last_input_tokens: null,
  };
  runs.set(run.run_id, run);

  channelMutex
    .run(channelId, () => executeChatRun({ run, channelId, projectId, projectTitle, session, text, context }))
    .catch((e) => {
      if (run.status !== 'done' && run.status !== 'error') {
        run.status = 'error';
        run.error = e?.message || String(e);
        run.finished_at = new Date();
        publish(run);
      }
      logger.error(`chat run ${run.run_id} crashed: ${e?.message || e}`);
    })
    .finally(() => {
      scheduleRunEviction(run.run_id);
    });

  return serializeChatRun(run);
}

async function executeChatRun({ run, channelId, projectId, projectTitle, session, text, context }) {
  const username = session?.username || 'web visitor';
  const discordUser = { id: `web:${username}`, displayName: username };
  let attachmentPaths = [];
  try {
    run.status = 'running';
    addProgress(run, 'reading the conversation…');

    const clearedAt = await getHistoryClearedAt(channelId);
    const rawHistory = await loadHistoryForLlm(channelId, {
      maxAgeMs: config.trim.historyWindowMs,
      since: clearedAt,
      minKeptUserTurns: config.trim.minKeptUserTurns,
    });
    const { messages: history } = config.trim.enabled
      ? trimHistoryForLlm(rawHistory, {
          tokenBudget: config.trim.tokenBudget,
          summarizeStale: config.trim.summarizeStale,
          minKeptUserTurns: config.trim.minKeptUserTurns,
        })
      : { messages: rawHistory };

    await recordUserMessage({
      projectId,
      msg: {
        channelId,
        guildId: null,
        thread: null,
        id: null,
        author: { id: discordUser.id, tag: discordUser.id, bot: false },
        createdAt: new Date(),
      },
      text,
      attachments: [],
      displayName: username,
    });

    const [characters, plot] = await Promise.all([
      listCharacters(projectId),
      getPlot(projectId),
    ]);
    const enhancement = await enhancePrompt({
      userText: text,
      characters,
      beats: plot?.beats || [],
      synopsis: plot?.synopsis || '',
    });
    if (enhancement.usage) {
      try {
        await recordAnthropicTextUsage({
          discordUser,
          channelId,
          model: config.anthropic.enhancerModel,
          totals: {
            input_tokens: enhancement.usage.input_tokens || 0,
            output_tokens: enhancement.usage.output_tokens || 0,
            cache_creation_input_tokens:
              enhancement.usage.cache_creation_input_tokens || 0,
            cache_read_input_tokens: enhancement.usage.cache_read_input_tokens || 0,
            iteration_count: 1,
          },
        });
      } catch (e) {
        logger.warn(`chat run: enhancer usage record failed: ${e.message}`);
      }
    }

    let pageContext = null;
    try {
      pageContext = await resolvePageContextNote({ projectId, projectTitle, context });
    } catch (e) {
      logger.warn(`chat run: page context resolve failed: ${e.message}`);
    }

    addProgress(run, 'thinking…');
    const result = await runAsEditor(session?.username, () => runAgent({
      history,
      userText: text,
      attachments: [],
      discordUser,
      channelId,
      enhancementNotes: enhancement.notes,
      projectId,
      projectTitle,
      webRun: true,
      pageContext,
      onEvent: (ev) => {
        if (ev?.type === 'tools') {
          for (const name of ev.tools || []) addProgress(run, `calling ${name}…`);
        }
      },
    }));
    attachmentPaths = result.attachmentPaths || [];

    try {
      await recordAgentTurns({
        channelId,
        projectId: result.projectId ?? projectId,
        turns: result.agentMessages,
      });
    } catch (e) {
      logger.error('chat run: failed to record agent turns', e);
    }

    try {
      const stats = await computeHistoryStats(channelId);
      run.estimated_tokens = stats.estimated_tokens;
      run.last_input_tokens = stats.last_input_tokens;
    } catch (e) {
      logger.warn(`chat run: history stats failed: ${e.message}`);
    }

    run.text = result.text || '(no reply)';
    run.interpreted = enhancement.summary || null;
    run.attachments = buildWebAttachments(attachmentPaths, result.attachmentLinks);
    run.status = 'done';
    run.finished_at = new Date();
    publish(run);
    logger.info(
      `chat run ${run.run_id} done (${result.agentMessages.length} turns, ${run.attachments.length} attachment(s))`,
    );
  } catch (e) {
    logger.error('chat run: agent failure', e);
    run.status = 'error';
    run.error = e?.message || String(e);
    run.finished_at = new Date();
    publish(run);
    try {
      await recordAssistantMessage({
        channelId,
        projectId,
        text: `Sorry — internal error: \`${run.error}\``,
      });
    } catch (e2) {
      logger.error('chat run: failed to record assistant error message', e2);
    }
  } finally {
    await cleanupTmpAttachments(attachmentPaths);
  }
}

// Exposed for tests that want to clear state between runs.
export function _resetChatRuns() {
  runs.clear();
  listeners.clear();
}
