export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(prefix: string): Logger;
}

export function createLogger(level: LogLevel = 'info', prefix = 'shortform'): Logger {
  const enabled = (candidate: Exclude<LogLevel, 'silent'>): boolean =>
    level !== 'silent' && ORDER[candidate] >= ORDER[level];

  const emit = (candidate: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown) => {
    if (!enabled(candidate)) return;
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `[${stamp}] ${candidate.toUpperCase().padEnd(5)} ${prefix} ${message}`;
    if (candidate === 'error' || candidate === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
    if (meta !== undefined) {
      const text = typeof meta === 'string' ? meta : JSON.stringify(meta);
      if (text) process.stdout.write(`        ${text}\n`);
    }
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (next) => createLogger(level, `${prefix}:${next}`),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
