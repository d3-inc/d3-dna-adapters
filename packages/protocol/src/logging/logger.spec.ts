import type { LogRecord } from '@logtape/logtape';
import { describe, expect, it } from 'vitest';
import { edgeConsoleFormatter } from './logger';

function record(message: readonly unknown[], properties: Record<string, unknown>): LogRecord {
  return {
    category: ['d3-edge', 'cloudflare-adapter'],
    message,
    properties,
  } as unknown as LogRecord;
}

const lineOf = (r: LogRecord): string => edgeConsoleFormatter(r)[0] as string;

describe('edgeConsoleFormatter', () => {
  it('keeps properties the message template never references', () => {
    const line = lineOf(record(['policy call failed'], { elapsedMs: 500 }));
    expect(line).toContain('policy call failed');
    expect(line).toContain('"elapsedMs":500');
  });

  it('serializes Error to name + message instead of {}', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const line = lineOf(record(['policy call failed'], { err }));
    expect(line).toContain('AbortError');
    expect(line).toContain('The operation was aborted');
    expect(line).not.toContain('{}');
  });

  it('caps a huge error message and surfaces the cause, in a property and interpolated alike', () => {
    const cause = new Error('unsupported Unicode escape sequence');
    cause.name = 'PostgresError';
    const err = new Error(`Failed query: insert into feed_row ${'x'.repeat(60_000)}`, { cause });
    err.name = 'DrizzleQueryError';

    for (const line of [
      lineOf(record(['sync failed'], { err })),
      lineOf(record(['sync failed: ', err, ''], {})),
    ]) {
      expect(line.length).toBeLessThan(1_000);
      expect(line).toContain('Failed query: insert into feed_row');
      expect(line).toContain('PostgresError: unsupported Unicode escape sequence');
    }
  });

  it('interpolates message values and still lists the property bag', () => {
    const line = lineOf(record(['policy-call: ', 'pass', ''], { action: 'pass', elapsedMs: 12 }));
    expect(line).toContain('policy-call: pass');
    expect(line).toContain('"action":"pass"');
  });

  it('prefixes the category and omits the props segment when empty', () => {
    expect(lineOf(record(['ready'], {}))).toBe('d3-edge·cloudflare-adapter ready');
  });

  it('renders an interpolated undefined value as a string, not a dropped part', () => {
    const line = lineOf(record(['ip=', undefined, ''], {}));
    expect(line).toBe('d3-edge·cloudflare-adapter ip=undefined');
  });

  it('never throws on an unserializable property', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => lineOf(record(['loop'], { circular }))).not.toThrow();
  });
});
