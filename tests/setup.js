process.env.DISCORD_BOT_TOKEN ||= 'test-token';
process.env.MOVIE_CHANNEL_ID ||= '0';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.MONGO_URI ||= 'mongodb://localhost:27017';
process.env.PDF_EXPORT_DIR ||= '/tmp/screenplay-test-exports';
process.env.BACKUP_DIR ||= '/tmp/screenplay-test-backups';
process.env.WEB_PORT ||= '0';
// Hard override (not ||=): the developer's real .env may set ADMIN_USERNAME,
// and src/config.js's `import 'dotenv/config'` would load it into every test
// run — but dotenv never overrides an already-defined var, so pre-defining it
// empty pins the suite to legacy open mode (permissions disabled). Permission
// tests set process.env.ADMIN_USERNAME explicitly per-case.
process.env.ADMIN_USERNAME = '';
