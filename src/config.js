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
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
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
    // The tools block and the large (~7.8k-token) stable system block are
    // byte-identical for hours/days, so they use the 1h TTL — for a Discord bot
    // with sporadic traffic, the default 5-minute ephemeral cache expires
    // between turns and forces a fresh write of those blocks almost every turn.
    toolsTtl: process.env.PROMPT_CACHE_TOOLS_TTL || '1h',
    systemTtl: process.env.PROMPT_CACHE_SYSTEM_TTL || '1h',
  },
  trim: {
    enabled: !process.env.HISTORY_TRIM_DISABLED,
    summarizeStale: !process.env.HISTORY_SUMMARIZE_DISABLED,
    tokenBudget: Number(process.env.HISTORY_TOKEN_BUDGET) || 30000,
    historyWindowMs: Number(process.env.HISTORY_WINDOW_MS) || 60 * 60 * 1000,
    // The last N user turns (with their agent responses) are never pruned by the
    // age window or the token budget — so walking away never wipes the thread.
    minKeptUserTurns: Number(process.env.HISTORY_MIN_KEPT_TURNS) || 6,
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
    intervalMs: Number(process.env.BACKUP_INTERVAL_MS) || 2 * 60 * 60 * 1000,
    retentionMs: Number(process.env.BACKUP_RETENTION_MS) || 24 * 60 * 60 * 1000,
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
  openai: {
    apiKey: process.env.OPENAI_API_KEY || null,
    imageTimeoutMs: Number(process.env.OPENAI_IMAGE_TIMEOUT_MS) || 600_000,
  },
  tmdb: {
    readAccessToken: process.env.TMDB_READ_ACCESS_TOKEN || null,
  },
  fal: {
    // fal.ai serverless models for video generation. Optional — without the
    // key the "Generate video" button on a storyboard scene surfaces a
    // friendly error and everything else keeps working. The SDK reads
    // FAL_KEY itself; we keep our own copy here so isConfigured() can stay
    // a pure function of config.
    apiKey: process.env.FAL_KEY || null,
    defaultModelId: process.env.FAL_DEFAULT_VIDEO_MODEL || 'kling-3-pro',
    // Flux Pro Kontext — image-conditioned generation. Single-image endpoint
    // requires `image_url` (singular). The image client picks this when 0 or 1
    // reference images are passed.
    fluxKontextModel: process.env.FAL_FLUX_KONTEXT_MODEL || 'fal-ai/flux-pro/kontext',
    // Flux Pro Kontext multi — required when 2+ reference images are passed.
    // Uses `image_urls` (plural). The single-image endpoint rejects requests
    // that send `image_urls`, so the image client routes multi-ref calls here.
    fluxKontextMultiModel:
      process.env.FAL_FLUX_KONTEXT_MULTI_MODEL || 'fal-ai/flux-pro/kontext/multi',
    // Nano Banana Pro (Google's Gemini 3 Pro Image hosted on fal.ai). Two
    // endpoints: the bare model is pure text-to-image (silently drops image
    // inputs); the /edit endpoint is image-to-image and requires `image_urls`.
    // The image client auto-routes between them based on whether the caller
    // passed any input images.
    nanoBananaProGenerateModel:
      process.env.FAL_NANO_BANANA_PRO_MODEL || 'fal-ai/nano-banana-pro',
    nanoBananaProEditModel:
      process.env.FAL_NANO_BANANA_PRO_EDIT_MODEL || 'fal-ai/nano-banana-pro/edit',
    // Flux 2 Pro on fal.ai. Same generate/edit split as Nano Banana Pro: the
    // bare model is text-to-image; /edit accepts up to 9 reference image URLs.
    flux2ProGenerateModel:
      process.env.FAL_FLUX_2_PRO_MODEL || 'fal-ai/flux-2-pro',
    flux2ProEditModel:
      process.env.FAL_FLUX_2_PRO_EDIT_MODEL || 'fal-ai/flux-2-pro/edit',
    // Gemini 2.5 Flash Image (original "Nano Banana"). Fast/cheap generate/edit
    // split — the bare endpoint is text-to-image, /edit takes image_urls.
    gemini25FlashGenerateModel:
      process.env.FAL_GEMINI_25_FLASH_MODEL || 'fal-ai/gemini-25-flash-image',
    gemini25FlashEditModel:
      process.env.FAL_GEMINI_25_FLASH_EDIT_MODEL || 'fal-ai/gemini-25-flash-image/edit',
    // Nano Banana 2 (Gemini 3.1 Flash). Newer fast Gemini; same generate/edit split.
    nanoBanana2GenerateModel:
      process.env.FAL_NANO_BANANA_2_MODEL || 'fal-ai/nano-banana-2',
    nanoBanana2EditModel:
      process.env.FAL_NANO_BANANA_2_EDIT_MODEL || 'fal-ai/nano-banana-2/edit',
    // FLUX.2 [klein] 9B. Distilled, 4-step fast model. Uses image_size (not
    // aspect_ratio); /edit caps at 4 reference images.
    flux2KleinGenerateModel:
      process.env.FAL_FLUX_2_KLEIN_MODEL || 'fal-ai/flux-2/klein/9b',
    flux2KleinEditModel:
      process.env.FAL_FLUX_2_KLEIN_EDIT_MODEL || 'fal-ai/flux-2/klein/9b/edit',
    // Input assets are uploaded into fal storage with this lifecycle. fal
    // bills for storage, so we expire inputs after a week by default.
    storageLifetimeDays: Number(process.env.FAL_STORAGE_LIFETIME_DAYS) || 7,
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
