import vm from 'node:vm';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 50;
const DEFAULT_MAX_OUTPUT_BYTES = 8192;

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a === undefined) return 'undefined';
  if (a === null) return 'null';
  if (typeof a === 'function') return `[Function: ${a.name || 'anonymous'}]`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function formatReturn(v) {
  if (v === undefined) return null;
  if (typeof v === 'function') return `[Function: ${v.name || 'anonymous'}]`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function runJsInVm(code, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  const t = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const stdout = [];
  const stderr = [];
  let outBytes = 0;
  let errBytes = 0;
  let outTrunc = false;
  let errTrunc = false;

  const push = (kind, args) => {
    const line = `${args.map(formatArg).join(' ')}\n`;
    if (kind === 'stdout') {
      if (outTrunc) return;
      const remaining = maxOutputBytes - outBytes;
      if (line.length > remaining) {
        if (remaining > 0) {
          stdout.push(line.slice(0, remaining));
          outBytes += remaining;
        }
        outTrunc = true;
        return;
      }
      stdout.push(line);
      outBytes += line.length;
    } else {
      if (errTrunc) return;
      const remaining = maxOutputBytes - errBytes;
      if (line.length > remaining) {
        if (remaining > 0) {
          stderr.push(line.slice(0, remaining));
          errBytes += remaining;
        }
        errTrunc = true;
        return;
      }
      stderr.push(line);
      errBytes += line.length;
    }
  };

  const sandbox = {
    console: {
      log: (...a) => push('stdout', a),
      info: (...a) => push('stdout', a),
      debug: (...a) => push('stdout', a),
      warn: (...a) => push('stderr', a),
      error: (...a) => push('stderr', a),
    },
  };

  const start = Date.now();
  let timedOut = false;
  let error = null;
  let returnValue;

  try {
    returnValue = vm.runInNewContext(code, sandbox, {
      timeout: t,
      displayErrors: false,
      filename: 'agent-code.js',
    });
  } catch (e) {
    if (e && typeof e.message === 'string' && /Script execution timed out/i.test(e.message)) {
      timedOut = true;
    } else {
      error = e;
    }
  }

  return {
    timed_out: timedOut,
    error: error ? `${error.name || 'Error'}: ${error.message}` : null,
    return_value: formatReturn(returnValue),
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    stdout_truncated: outTrunc,
    stderr_truncated: errTrunc,
    duration_ms: Date.now() - start,
  };
}
