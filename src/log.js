const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[process.env.LOG_LEVEL || 'info'] ?? 20;

function log(level, ...args) {
  if (levels[level] < threshold) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
}

export const logger = {
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
};
