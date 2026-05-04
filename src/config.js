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
    enhancerModel: process.env.ANTHROPIC_ENHANCER_MODEL || 'claude-haiku-4-5-20251001',
  },
  enhance: {
    enabled: !process.env.ENHANCE_PROMPTS_DISABLED,
    maxNotesChars: Number(process.env.ENHANCE_MAX_NOTES_CHARS) || 1500,
    maxSummaryChars: Number(process.env.ENHANCE_MAX_SUMMARY_CHARS) || 200,
  },
  cache: {
    enabled: !process.env.PROMPT_CACHE_DISABLED,
    toolsTtl: process.env.PROMPT_CACHE_TOOLS_TTL || '1h',
  },
  trim: {
    enabled: !process.env.HISTORY_TRIM_DISABLED,
    summarizeStale: !process.env.HISTORY_SUMMARIZE_DISABLED,
    tokenBudget: Number(process.env.HISTORY_TOKEN_BUDGET) || 30000,
    historyWindowMs: Number(process.env.HISTORY_WINDOW_MS) || 60 * 60 * 1000,
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
  chroma: {
    // CHROMA_URL is auto-set to http://chroma:8000 inside docker-compose
    // (the container always listens on 8000 internally); for local
    // `npm run dev` we default to localhost:8599 (the chroma service
    // publishes 8599 → 8000 to avoid clashing with anything else on 8000).
    // Users only need to set VOYAGE_API_KEY.
    url: process.env.CHROMA_URL || 'http://localhost:8599',
    collection: process.env.CHROMA_COLLECTION || 'screenplay',
  },
  voyage: {
    apiKey: process.env.VOYAGE_API_KEY || null,
    model: process.env.VOYAGE_MODEL || 'voyage-3',
  },
  rag: {
    // Enabled whenever VOYAGE_API_KEY is set. CHROMA_URL has a default;
    // if Chroma isn't actually reachable the handler degrades to a
    // friendly fallback string.
    get enabled() {
      return !!process.env.VOYAGE_API_KEY;
    },
    debounceMs: Number(process.env.RAG_DEBOUNCE_MS) || 1000,
    messageWindow: Number(process.env.RAG_MESSAGE_WINDOW) || 5000,
    defaultK: Number(process.env.RAG_DEFAULT_K) || 8,
    pruneEveryN: Number(process.env.RAG_PRUNE_EVERY_N) || 100,
  },
  agent: {
    bodyPreviewThreshold:
      Number(process.env.AGENT_BODY_PREVIEW_THRESHOLD) || 8000,
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
