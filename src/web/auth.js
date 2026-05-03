// Auth REST endpoints for the SPA.
//
// POST /auth/request   { username }            → { request_id }
// GET  /auth/status    ?request_id=…           → { status, session_id?, username? }
// POST /auth/validate  { session_id }          → { valid, username? }
//
// On a fresh request the server posts an embed with Approve/Deny buttons in
// the configured Discord channel. Anyone in the channel can click. The
// browser polls /auth/status until the request resolves.

import express from 'express';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../log.js';
import {
  createAuthRequest,
  getAuthRequest,
  getSession,
  setRequestDiscordMessage,
  touchSession,
} from '../mongo/auth.js';

const USERNAME_RE = /^[\p{L}\p{N}_\- .']{1,40}$/u;

function sanitizeUsername(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (!USERNAME_RE.test(s)) return null;
  return s;
}

function buildEmbed(username, requestId) {
  return new EmbedBuilder()
    .setTitle('Editor access requested')
    .setDescription(
      [
        `**${username}** is requesting access to the screenplay editor.`,
        '',
        'Approve or deny below. Anyone in this channel can decide.',
      ].join('\n'),
    )
    .setColor(0x7aa6ff)
    .setFooter({ text: `request_id: ${requestId}` })
    .setTimestamp(new Date());
}

function buildButtons(requestId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`auth:approve:${requestId}`)
      .setStyle(ButtonStyle.Success)
      .setLabel('Approve')
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`auth:deny:${requestId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel('Deny')
      .setEmoji('❌'),
  );
}

let discordClientRef = null;

export function bindDiscordClient(client) {
  discordClientRef = client;
}

async function postApprovalRequest({ username, requestId }) {
  if (!discordClientRef) {
    throw new Error('Discord client not bound — auth requests cannot post.');
  }
  const channel = await discordClientRef.channels.fetch(config.discord.movieChannelId);
  if (!channel) throw new Error('movie channel unavailable');
  const msg = await channel.send({
    embeds: [buildEmbed(username, requestId)],
    components: [buildButtons(requestId)],
  });
  await setRequestDiscordMessage(requestId, {
    messageId: msg.id,
    channelId: channel.id,
  });
  return msg;
}

export function buildAuthRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.post('/request', async (req, res) => {
    const username = sanitizeUsername(req.body?.username);
    if (!username) {
      return res
        .status(400)
        .json({ error: 'username must be 1–40 chars, letters/numbers/space/._-' });
    }
    let request;
    try {
      request = await createAuthRequest({
        username,
        ttlMs: config.web.authRequestTtlMs,
      });
    } catch (e) {
      logger.error('auth /request create failed', e);
      return res.status(500).json({ error: 'internal' });
    }
    try {
      await postApprovalRequest({ username, requestId: request.request_id });
    } catch (e) {
      logger.error(`auth /request discord post failed: ${e.message}`);
      return res.status(502).json({ error: 'could not post to discord' });
    }
    return res.json({ request_id: request.request_id });
  });

  router.get('/status', async (req, res) => {
    const requestId = String(req.query.request_id || '');
    if (!requestId) return res.status(400).json({ error: 'request_id required' });
    const r = await getAuthRequest(requestId);
    if (!r) return res.json({ status: 'expired' });
    if (r.expires_at && r.expires_at < new Date() && r.status === 'pending') {
      return res.json({ status: 'expired' });
    }
    if (r.status === 'approved') {
      return res.json({
        status: 'approved',
        session_id: r.session_id,
        username: r.username,
      });
    }
    if (r.status === 'denied') {
      return res.json({ status: 'denied' });
    }
    return res.json({ status: 'pending' });
  });

  router.post('/validate', async (req, res) => {
    const sessionId = String(req.body?.session_id || '');
    if (!sessionId) return res.json({ valid: false });
    const s = await getSession(sessionId);
    if (!s) return res.json({ valid: false });
    touchSession(sessionId).catch(() => {});
    return res.json({ valid: true, username: s.username });
  });

  return router;
}

// Express middleware that attaches `req.session` if a valid session id is sent
// in the X-Session-Id header. Returns 401 otherwise.
export function requireSession() {
  return async (req, res, next) => {
    const sessionId = String(req.headers['x-session-id'] || '');
    if (!sessionId) return res.status(401).json({ error: 'missing session' });
    const s = await getSession(sessionId);
    if (!s) return res.status(401).json({ error: 'invalid session' });
    touchSession(sessionId).catch(() => {});
    req.session = s;
    next();
  };
}
