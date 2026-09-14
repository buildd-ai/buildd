import { describe, it, expect } from 'bun:test';
import { buildErrorPatternPanel, type ErrorPatternTraceRow } from './error-pattern-cost';

const GATED_SINCE = '2026-09-07';

const trace = (over: Partial<ErrorPatternTraceRow> = {}): ErrorPatternTraceRow => ({
  pattern: 'git_fatal',
  workerId: 'w-1',
  workerFailed: false,
  ...over,
});

describe('buildErrorPatternPanel', () => {
  it('is unavailable with no scanned workers and a window that does not predate the gate', () => {
    const panel = buildErrorPatternPanel({
      rows: [],
      scannedWorkers: 0,
      windowStart: new Date('2026-09-10T00:00:00Z'),
      rowLimit: 5000,
      gatedSince: GATED_SINCE,
    });
    expect(panel.kind).toBe('unavailable');
    expect(panel.reason).toBe('no_scope');
  });

  it('flags no_baseline when scannedWorkers is 0 and the window predates the gate', () => {
    const panel = buildErrorPatternPanel({
      rows: [],
      scannedWorkers: 0,
      windowStart: new Date('2026-08-01T00:00:00Z'),
      rowLimit: 5000,
      gatedSince: GATED_SINCE,
    });
    expect(panel.kind).toBe('unavailable');
    expect(panel.reason).toBe('no_baseline');
  });

  it('flags windowPredatesCapture independent of whether traces were found', () => {
    const panel = buildErrorPatternPanel({
      rows: [trace()],
      scannedWorkers: 3,
      windowStart: new Date('2026-08-01T00:00:00Z'), // before the gate date
      rowLimit: 5000,
      gatedSince: GATED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') expect(panel.value.windowPredatesCapture).toBe(true);
  });

  it('a real zero (no pattern fired) is measured, not unavailable', () => {
    const panel = buildErrorPatternPanel({
      rows: [],
      scannedWorkers: 15,
      windowStart: new Date('2026-09-10T00:00:00Z'),
      rowLimit: 5000,
      gatedSince: GATED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') expect(panel.value.patterns).toEqual([]);
  });

  it('ranks by distinct failed workers, not raw occurrence count', () => {
    const panel = buildErrorPatternPanel({
      rows: [
        // git_fatal: 3 distinct workers, all terminally failed. Only 3 rows.
        trace({ pattern: 'git_fatal', workerId: 'w-1', workerFailed: true }),
        trace({ pattern: 'git_fatal', workerId: 'w-2', workerFailed: true }),
        trace({ pattern: 'git_fatal', workerId: 'w-3', workerFailed: true }),
        // cd_no_such_file: chatty, fires many times across many workers, but
        // every one of those workers went on to succeed.
        ...Array.from({ length: 40 }, (_, i) =>
          trace({ pattern: 'cd_no_such_file', workerId: `w-${100 + (i % 12)}`, workerFailed: false })),
      ],
      scannedWorkers: 20,
      windowStart: new Date('2026-09-10T00:00:00Z'),
      rowLimit: 5000,
      gatedSince: GATED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind !== 'value') return;
    expect(panel.value.patterns[0].pattern).toBe('git_fatal');
    expect(panel.value.patterns[0].failedWorkers).toBe(3);
    expect(panel.value.patterns[1].pattern).toBe('cd_no_such_file');
    expect(panel.value.patterns[1].occurrences).toBe(40);
    expect(panel.value.patterns[1].workers).toBe(12);
    expect(panel.value.patterns[1].failedWorkers).toBe(0);
  });

  it('deduplicates occurrences into distinct-worker counts per pattern', () => {
    const panel = buildErrorPatternPanel({
      rows: [
        trace({ pattern: 'enoent', workerId: 'w-1', workerFailed: true }),
        trace({ pattern: 'enoent', workerId: 'w-1', workerFailed: true }),
        trace({ pattern: 'enoent', workerId: 'w-2', workerFailed: false }),
      ],
      scannedWorkers: 5,
      windowStart: new Date('2026-09-10T00:00:00Z'),
      rowLimit: 5000,
      gatedSince: GATED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind !== 'value') return;
    const row = panel.value.patterns.find(p => p.pattern === 'enoent')!;
    expect(row.occurrences).toBe(3);
    expect(row.workers).toBe(2);
    expect(row.failedWorkers).toBe(1);
  });

  it('flags truncated when the row cap was hit', () => {
    const panel = buildErrorPatternPanel({
      rows: [trace(), trace({ workerId: 'w-2' })],
      scannedWorkers: 5,
      windowStart: new Date('2026-09-10T00:00:00Z'),
      rowLimit: 2,
      gatedSince: GATED_SINCE,
    });
    expect(panel.kind).toBe('value');
    if (panel.kind === 'value') expect(panel.value.truncated).toBe(true);
  });
});
