import 'dotenv/config';

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
  },
  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    db: process.env.MONGO_DB || 'screenplay',
  },
  pdf: {
    exportDir: process.env.PDF_EXPORT_DIR || '/data/exports',
  },
  web: {
    port: Number(process.env.WEB_PORT) || 3000,
    publicBaseUrl: process.env.WEB_PUBLIC_BASE_URL || null,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null,
  },
  tmdb: {
    readAccessToken: process.env.TMDB_READ_ACCESS_TOKEN || null,
  },
  tavily: {
    apiKey: process.env.TAVILY_API_KEY || null,
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};
