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
  logLevel: process.env.LOG_LEVEL || 'info',
};
