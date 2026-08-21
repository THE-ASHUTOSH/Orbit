/**
 * Structured line logs. One JSON object per line in production (greppable,
 * shippable), colourised key=value in development.
 *
 * Never log passwords, cookies, tokens or page content: `redact` strips the
 * fields that tend to carry them if they are ever passed in by accident.
 */
import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

const SECRET_KEYS = /^(password|passwordHash|password_hash|token|cookie|cookies|secret|authorization|clipboard|text|value)$/i;

export interface LogContext {
  requestId?: string;
  userId?: string;
  username?: string;
  tabId?: string;
  browserId?: string;
  sessionId?: string;
  [k: string]: unknown;
}

function redact(ctx: LogContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (v instanceof Error) out[k] = v.message;
    else out[k] = v;
  }
  return out;
}

function emit(level: Level, msg: string, ctx: LogContext = {}) {
  if (RANK[level] < RANK[config.logLevel]) return;
  const fields = redact(ctx);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (config.isProd) {
    stream.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
  } else {
    const tail = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    stream.write(`${COLOR[level]}[${level.toUpperCase()}]\x1b[0m ${msg}${tail ? ' ' + tail : ''}\n`);
  }
}

export const log = {
  debug: (m: string, c?: LogContext) => emit('debug', m, c),
  info: (m: string, c?: LogContext) => emit('info', m, c),
  warn: (m: string, c?: LogContext) => emit('warn', m, c),
  error: (m: string, c?: LogContext) => emit('error', m, c),
  /** Returns a logger that stamps every line with the given context. */
  child(base: LogContext) {
    return {
      debug: (m: string, c?: LogContext) => emit('debug', m, { ...base, ...c }),
      info: (m: string, c?: LogContext) => emit('info', m, { ...base, ...c }),
      warn: (m: string, c?: LogContext) => emit('warn', m, { ...base, ...c }),
      error: (m: string, c?: LogContext) => emit('error', m, { ...base, ...c }),
    };
  },
};
