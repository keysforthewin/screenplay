// server.js
//
// The MCP listener: streamable HTTP on its own port (config.mcp.port), no
// auth, for command-line coding agents on this machine.
//
//   POST /mcp      the MCP endpoint. Stateless: every request gets a fresh
//                  server + transport, so there are no sessions to lose on a
//                  restart and nothing to resume.
//   PUT  /upload   ?cut_id=<id>&target=start_frame|end_frame|video — the raw
//   POST /upload   bytes of a local file as the body (curl -T). Files do not
//                  travel as tool arguments: an agent would have to write
//                  megabytes of base64.
//   GET  /health
//
// It runs inside the bot process because every write goes through the
// mutation gateway, which needs the in-process Hocuspocus to reach open
// editors.

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import { McpInputError, resolveCut } from './resolve.js';
import { frameName, setCutVideo, setFrameImage } from './store.js';
import { buildMcpServer } from './tools.js';

const MAX_UPLOAD = '1gb';

function rpcError(res, status, message) {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

function uploadBase(req = null) {
  if (config.mcp.publicUrl) return config.mcp.publicUrl.replace(/\/+$/, '');
  if (req?.headers?.host) return `http://${req.headers.host}`;
  return `http://localhost:${config.mcp.port}`;
}

export function buildMcpApp() {
  const app = express();
  const allowed = config.mcp.allowedHosts;
  if (!allowed.includes('*')) app.use(hostHeaderValidation(allowed));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, mcp: '/mcp', upload: '/upload' });
  });

  app.post('/mcp', express.json({ limit: '8mb' }), async (req, res) => {
    const server = buildMcpServer({ uploadBase: uploadBase(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logger.warn(`mcp: request failed: ${e?.stack || e}`);
      if (!res.headersSent) rpcError(res, 500, 'Internal server error');
    }
  });
  // No sessions, so nothing to stream to or to end.
  app.get('/mcp', (_req, res) => rpcError(res, 405, 'Method not allowed.'));
  app.delete('/mcp', (_req, res) => rpcError(res, 405, 'Method not allowed.'));

  async function upload(req, res) {
    try {
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) {
        throw new McpInputError('Send the file as the raw request body, e.g. curl -T frame.png "<url>"');
      }
      const target = String(req.query.target || req.query.frame || '').toLowerCase();
      if (!req.query.cut_id) throw new McpInputError('cut_id is required');
      const { projectId, cut } = await resolveCut(String(req.query.cut_id));
      const model = req.query.model ? String(req.query.model) : null;
      let out;
      if (target === 'video') {
        out = await setCutVideo({
          projectId,
          cut,
          buffer: body,
          contentType: req.headers['content-type'] || null,
          durationSeconds: req.query.duration_seconds,
          model,
        });
      } else if (target) {
        out = await setFrameImage({ projectId, cut, frame: frameName(target), buffer: body, model });
      } else {
        throw new McpInputError('target is required: start_frame, end_frame or video');
      }
      res.json({ ok: true, cut: out });
    } catch (e) {
      if (!(e instanceof McpInputError)) logger.warn(`mcp: upload failed: ${e?.stack || e}`);
      res.status(e instanceof McpInputError ? 400 : 500).json({ ok: false, error: e?.message || String(e) });
    }
  }
  const raw = express.raw({ type: () => true, limit: MAX_UPLOAD });
  app.put('/upload', raw, upload);
  app.post('/upload', raw, upload);

  return app;
}

let listener = null;

// Resolves once the port is bound (or at once when MCP_PORT=0). A port that
// cannot be bound is logged, not fatal: the bot is worth more than this.
export function startMcpServer() {
  const { port, host } = config.mcp;
  if (!port) {
    logger.info('mcp: disabled (MCP_PORT=0)');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const server = buildMcpApp().listen(port, host);
    server.once('listening', () => {
      listener = server;
      logger.info(`mcp: listening on http://${host}:${port}/mcp (no auth)`);
      resolve(server);
    });
    server.once('error', (e) => {
      logger.error(`mcp: could not listen on ${host}:${port}: ${e.message}`);
      resolve(null);
    });
  });
}

export function stopMcpServer() {
  const server = listener;
  listener = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
