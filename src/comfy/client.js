// MCP client for the comfy-mcp stdio server — the bot's only door to ComfyUI.
//
// comfy-mcp 0.10.0 speaks MCP over stdio and nothing else, so the bot spawns
// it as a child process (config.comfy.mcpCommand) and calls its tools through
// @modelcontextprotocol/sdk. comfy-cli inside it targets whatever COMFYUI_URL
// names, local or remote; file-taking tools (upload_file, fetch_outputs) act
// on THIS machine's filesystem, which is why comfy-mcp must run next to the
// bot rather than next to ComfyUI.
//
// Optional integration: when COMFYUI_URL is unset every call throws
// ComfyNotConfiguredError (503) and nothing is spawned.

import { config } from '../config.js';
import { logger } from '../log.js';

export class ComfyNotConfiguredError extends Error {
  constructor() {
    super('ComfyUI is not configured (set COMFYUI_URL and install comfy-mcp).');
    this.code = 'COMFY_NOT_CONFIGURED';
    this.status = 503;
  }
}

export class ComfyUnavailableError extends Error {
  constructor(message) {
    super(message || 'ComfyUI is unavailable.');
    this.code = 'COMFY_UNAVAILABLE';
    this.status = 503;
  }
}

export class ComfyToolError extends Error {
  constructor(tool, message, detail = null) {
    super(`comfy ${tool}: ${message}`);
    this.code = 'COMFY_TOOL_ERROR';
    this.tool = tool;
    this.detail = detail;
  }
}

// True when COMFYUI_URL is set — or when a test installed a fake client.
export function isComfyConfigured() {
  return !!override || !!config.comfy.url;
}

// Tool results arrive as { content: [{ type: 'text', text }], isError? }.
// comfy-mcp writes JSON into the text block; fall back to the raw string.
export function parseToolResult(tool, result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''));
  const joined = texts.join('\n').trim();
  let parsed = joined;
  if (joined) {
    try {
      parsed = JSON.parse(joined);
    } catch {
      parsed = joined;
    }
  } else if (result?.structuredContent !== undefined) {
    parsed = result.structuredContent;
  }
  if (result?.isError) {
    const message =
      (parsed && typeof parsed === 'object' && (parsed.message || parsed.error?.message || parsed.error)) ||
      joined ||
      'tool reported an error';
    throw new ComfyToolError(tool, typeof message === 'string' ? message : JSON.stringify(message), parsed);
  }
  return parsed;
}

// Per-tool request timeouts (ms). comfy-mcp itself bounds most of these;
// ours just have to be longer than its own so we see its error, not a
// client-side RequestTimeout.
const TOOL_TIMEOUTS = {
  server_info: 60_000,
  search_templates: 60_000,
  get_template: 120_000,
  fetch_template: 180_000,
  list_workflow_slots: 60_000,
  set_workflow_slot: 60_000,
  validate_workflow: 60_000,
  list_workflow_notes: 60_000,
  upload_file: 330_000,
  run_workflow: 180_000,
  job: 3_700_000,
  fetch_outputs: 330_000,
  list_partner_models: 60_000,
  partner_model_schema: 60_000,
};

let clientPromise = null;
let override = null;

export function _setComfyClientForTests(fake) {
  override = fake || null;
  clientPromise = null;
}

async function spawnClient() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const env = { ...process.env, COMFYUI_URL: config.comfy.url };
  if (config.comfy.comfyBin) env.COMFY_BIN = config.comfy.comfyBin;
  const transport = new StdioClientTransport({
    command: config.comfy.mcpCommand,
    args: [],
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on?.('data', (chunk) => {
    const line = String(chunk).trim();
    if (line) logger.debug(`comfy-mcp: ${line.slice(0, 500)}`);
  });
  const client = new Client({ name: 'screenplay-bot', version: '0.1.0' }, { capabilities: {} });
  transport.onclose = () => {
    logger.warn('comfy-mcp: transport closed; next call respawns it');
    clientPromise = null;
  };
  transport.onerror = (e) => {
    logger.warn(`comfy-mcp: transport error: ${e?.message || e}`);
  };
  try {
    await client.connect(transport);
  } catch (e) {
    clientPromise = null;
    throw new ComfyUnavailableError(
      `could not start comfy-mcp (${config.comfy.mcpCommand}): ${e?.message || e}`,
    );
  }
  logger.info(`comfy-mcp: connected (target ${config.comfy.url})`);
  return {
    async callTool(name, args = {}) {
      const timeout = TOOL_TIMEOUTS[name] || 120_000;
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout,
        resetTimeoutOnProgress: true,
      });
      return parseToolResult(name, result);
    },
    async close() {
      try {
        await client.close();
      } catch {}
    },
  };
}

export async function getComfyClient() {
  if (override) return override;
  if (!isComfyConfigured()) throw new ComfyNotConfiguredError();
  if (!clientPromise) clientPromise = spawnClient();
  return clientPromise;
}

export async function closeComfyClient() {
  if (!clientPromise) return;
  const p = clientPromise;
  clientPromise = null;
  try {
    const c = await p;
    await c.close();
  } catch {}
}

export async function callComfyTool(name, args = {}) {
  const c = await getComfyClient();
  return c.callTool(name, args);
}

export const comfy = {
  serverInfo: () => callComfyTool('server_info', {}),
  searchTemplates: (query, opts = {}) => callComfyTool('search_templates', { query, ...opts }),
  getTemplate: (name, { checkLocal = true } = {}) => callComfyTool('get_template', { name, check_local: checkLocal }),
  fetchTemplate: (name, outPath, { checkLocal = true } = {}) =>
    callComfyTool('fetch_template', { name, out_path: outPath, check_local: checkLocal }),
  listWorkflowSlots: (workflowPath) => callComfyTool('list_workflow_slots', { workflow_path: workflowPath }),
  setWorkflowSlot: (workflowPath, overrides, { stdout = false } = {}) =>
    callComfyTool('set_workflow_slot', { workflow_path: workflowPath, overrides, stdout }),
  listWorkflowNotes: (workflowPath) => callComfyTool('list_workflow_notes', { workflow_path: workflowPath }),
  // Pre-flight a workflow (API or UI format) against the live object_info:
  // { valid, errors[], warnings[] }. An invalid graph is a normal answer.
  validateWorkflow: (workflowPath) => callComfyTool('validate_workflow', { workflow_path: workflowPath }),
  uploadFile: (paths, { overwrite = true } = {}) => callComfyTool('upload_file', { paths, overwrite }),
  runWorkflow: (workflowPath, { wait = false, confirmSpend = false, timeoutSeconds = 110 } = {}) =>
    callComfyTool('run_workflow', {
      workflow_path: workflowPath,
      wait,
      confirm_spend: confirmSpend,
      timeout_seconds: timeoutSeconds,
    }),
  job: (action, promptId = '', timeoutSeconds = null) => {
    const args = { action };
    if (promptId) args.prompt_id = promptId;
    if (timeoutSeconds != null) args.timeout_seconds = timeoutSeconds;
    return callComfyTool('job', args);
  },
  fetchOutputs: (promptId, outDir) => callComfyTool('fetch_outputs', { prompt_id: promptId, out_dir: outDir }),
  listPartnerModels: (opts = {}) => callComfyTool('list_partner_models', opts),
  partnerModelSchema: (model) => callComfyTool('partner_model_schema', { model }),
};
