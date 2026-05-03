import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  discord: {
    token: required('DISCORD_BOT_TOKEN'),
    movieChannelId: required('MOVIE_CHANNEL_ID'),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS) || 16000,
  },
  cache: {
    enabled: !process.env.PROMPT_CACHE_DISABLED,
    toolsTtl: process.env.PROMPT_CACHE_TOOLS_TTL || '1h',
  },
  trim: {
    enabled: !process.env.HISTORY_TRIM_DISABLED,
    summarizeStale: !process.env.HISTORY_SUMMARIZE_DISABLED,
    tokenBudget: Number(process.env.HISTORY_TOKEN_BUDGET) || 30000,
  },
  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    db: process.env.MONGO_DB || 'screenplay',
  },
  pdf: {
    exportDir: process.env.PDF_EXPORT_DIR || '/data/exports',
  },
  backup: {
    dir: process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'),
    intervalMs: Number(process.env.BACKUP_INTERVAL_MS) || 30 * 60 * 1000,
    retentionMs: Number(process.env.BACKUP_RETENTION_MS) || 48 * 60 * 60 * 1000,
    startupDelayMs: Number(process.env.BACKUP_STARTUP_DELAY_MS) || 60 * 1000,
  },
  web: {
    port: Number(process.env.WEB_PORT) || 3000,
    publicBaseUrl: process.env.WEB_PUBLIC_BASE_URL || null,
    hocuspocusPort: Number(process.env.HOCUSPOCUS_PORT) || 3001,
    hocuspocusPublicUrl: process.env.HOCUSPOCUS_PUBLIC_URL || null,
    staticDir: process.env.WEB_STATIC_DIR || path.resolve(process.cwd(), 'web/dist'),
    authRequestTtlMs: Number(process.env.AUTH_REQUEST_TTL_MS) || 5 * 60 * 1000,
    botColor: process.env.BOT_PRESENCE_COLOR || '#ffb86b',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null,
    vertex: {
      project: process.env.GEMINI_VERTEX_PROJECT || null,
      location: process.env.GEMINI_VERTEX_LOCATION || 'us-central1',
    },
  },
  tmdb: {
    readAccessToken: process.env.TMDB_READ_ACCESS_TOKEN || null,
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY || null,
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
