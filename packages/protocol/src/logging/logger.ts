import {
  configureSync,
  getConsoleSink,
  getLogger,
  resetSync,
  type Logger,
  type LogLevel,
  type LogRecord,
} from '@logtape/logtape';

export type { Logger, LogLevel };

/** Root category every D3 Edge logger hangs off; entrypoints configure it. */
export const LOG_ROOT = 'd3-edge';

/**
 * Logger under the d3-edge root. Output stays silent until an entrypoint calls
 * configureEdgeLogging() — the intended default for tests and unconfigured consumers.
 */
export function edgeLogger(...subcategory: string[]): Logger {
  return getLogger([LOG_ROOT, ...subcategory]);
}

// A failed bulk query's message carries its whole SQL and every parameter: one erc8004 chunk logged ~60 KB.
const MAX_ERROR_MESSAGE_CHARS = 512;

export function clipErrorMessage(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_CHARS ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}…` : text;
}

function errorSummary(err: Error): { name: string; message: string; cause?: string } {
  const summary = { name: err.name, message: clipErrorMessage(err.message) };
  // A query wrapper's message is the query; the driver's reason is the cause.
  return err.cause instanceof Error
    ? { ...summary, cause: `${err.cause.name}: ${clipErrorMessage(err.cause.message)}` }
    : summary;
}

function errorReplacer(_key: string, value: unknown): unknown {
  // JSON.stringify renders an Error as `{}`; keep its name/message.
  return value instanceof Error ? errorSummary(value) : value;
}

function safeJson(value: unknown): string {
  try {
    // JSON.stringify returns undefined for undefined/function/symbol; fall back to String.
    return JSON.stringify(value, errorReplacer) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Error) {
    const { name, message, cause } = errorSummary(value);
    return cause ? `${name}: ${message} (cause: ${cause})` : `${name}: ${message}`;
  }

  return typeof value === 'string' ? value : safeJson(value);
}

/** The default console formatter emits only the message, dropping every property; this appends them. */
export function edgeConsoleFormatter(record: LogRecord): readonly unknown[] {
  const message = record.message.map((part, i) => (i % 2 === 0 ? String(part) : formatValue(part))).join('');
  const props = Object.keys(record.properties).length > 0 ? ` ${safeJson(record.properties)}` : '';
  return [`${record.category.join('·')} ${message}${props}`];
}

let configured = false;

/**
 * Point the d3-edge category at the console. Idempotent across a single isolate.
 * Uses the sync API so it's safe at module load in workerd (no top-level await).
 */
export function configureEdgeLogging(lowestLevel: LogLevel = 'info'): void {
  if (configured) return;
  configured = true;
  configureSync({
    reset: true,
    sinks: { console: getConsoleSink({ formatter: edgeConsoleFormatter }) },
    loggers: [
      { category: [LOG_ROOT], lowestLevel, sinks: ['console'] },
      // LogTape's own diagnostics: keep them quiet unless something breaks.
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
    ],
  });
}

/**
 * Lock logging into the silent default and block any later configureEdgeLogging().
 * For test setup files: worker entrypoints configure at module load, and pooled test
 * runtimes (e.g. vitest-pool-workers loads the worker `main` into every isolate) leak
 * that config across spec files. Calling this once via `setupFiles` keeps the whole
 * isolate quiet regardless of whether it runs before or after the entrypoint loads —
 * it both resets any existing config and trips the guard so nothing re-enables it.
 */
export function silenceEdgeLogging(): void {
  configured = true;
  resetSync();
}
