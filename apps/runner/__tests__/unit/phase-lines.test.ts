import { describe, expect, test } from 'bun:test';
import {
  CACHE_SKIPPED_LINE_PREFIX,
  CACHE_SKIP_PARTS,
  emitCacheSkipped,
  formatCacheSkippedLine,
  METRIC_LINE_PREFIX,
  PHASE_LINE_PREFIX,
  REPO_FALLBACK_REASONS,
  REPO_SOURCE_LINE_PREFIX,
  RUN_METRICS,
  RUN_PHASES,
  emitMetric,
  emitPhase,
  emitRepoSource,
  formatMetricLine,
  formatPhaseLine,
  formatRepoSourceLine,
  phaseLinesEnabled,
} from '../../src/phase-lines';

describe('phase lines', () => {
  test('format: BUILDD_PHASE=<phase> <epoch ms>', () => {
    expect(PHASE_LINE_PREFIX).toBe('BUILDD_PHASE=');
    expect(formatPhaseLine('clone_start', 1_700_000_000_123)).toBe('BUILDD_PHASE=clone_start 1700000000123');
    expect(RUN_PHASES).toEqual([
      'clone_start', 'clone_end', 'install_start', 'install_end',
      'restore_warm_start', 'restore_warm_end', 'fetch_start', 'fetch_end',
      'warm_upload_start', 'warm_upload_end',
      'park_start', 'park_end', 'restore_park_start', 'restore_park_end',
      'restore_cache_start', 'restore_cache_end',
    ]);
  });

  test('metric lines: BUILDD_METRIC=<name> <non-negative integer>', () => {
    expect(METRIC_LINE_PREFIX).toBe('BUILDD_METRIC=');
    expect(RUN_METRICS).toEqual(['clone_bytes', 'restore_bytes', 'fetch_bytes', 'cache_bytes', 'snapshot_age_ms', 'warm_upload_bytes', 'park_bytes', 'resume_layer', 'warm_repo_bytes', 'cache_raw_bytes', 'mem_peak_bytes', 'mem_limit_bytes', 'disk_free_min_bytes', 'disk_total_bytes']);
    expect(formatMetricLine('fetch_bytes', 1234.9)).toBe('BUILDD_METRIC=fetch_bytes 1234');
    expect(formatMetricLine('fetch_bytes', -5)).toBe('BUILDD_METRIC=fetch_bytes 0');
  });

  test('cache skipped line: BUILDD_CACHE_SKIPPED=<part> <bytes> <cap>, cloud only', () => {
    expect(CACHE_SKIPPED_LINE_PREFIX).toBe('BUILDD_CACHE_SKIPPED=');
    expect(CACHE_SKIP_PARTS).toEqual(['pnpm-store', 'cache']);
    expect(formatCacheSkippedLine('pnpm-store', 2_100_000.7, 1024)).toBe('BUILDD_CACHE_SKIPPED=pnpm-store 2100000 1024');
    const out: string[] = [];
    emitCacheSkipped('cache', 5, 4, { env: { BUILDD_EXECUTOR: 'cloud' }, log: (l) => out.push(l) });
    emitCacheSkipped('cache', 5, 4, { env: {}, log: (l) => out.push(l) });
    expect(out).toEqual(['BUILDD_CACHE_SKIPPED=cache 5 4']);
  });

  test('repo source line: warm, or clone with a reason from a closed list', () => {
    expect(REPO_SOURCE_LINE_PREFIX).toBe('BUILDD_REPO_SOURCE=');
    expect(REPO_FALLBACK_REASONS).toEqual(['disabled', 'no_snapshot', 'unavailable', 'disk', 'restore_failed']);
    expect(formatRepoSourceLine('warm')).toBe('BUILDD_REPO_SOURCE=warm');
    expect(formatRepoSourceLine('clone', 'disk')).toBe('BUILDD_REPO_SOURCE=clone disk');
  });

  test('metric and source lines follow the same cloud-only switch', () => {
    const out: string[] = [];
    const on = { env: { BUILDD_EXECUTOR: 'cloud' }, log: (l: string) => out.push(l) };
    const off = { env: {}, log: (l: string) => out.push(l) };
    emitMetric('clone_bytes', 10, on);
    emitMetric('clone_bytes', 10, off);
    emitRepoSource('clone', 'no_snapshot', on);
    emitRepoSource('warm', undefined, off);
    expect(out).toEqual(['BUILDD_METRIC=clone_bytes 10', 'BUILDD_REPO_SOURCE=clone no_snapshot']);
  });

  test('only printed in a cloud container (BUILDD_EXECUTOR=cloud)', () => {
    expect(phaseLinesEnabled({ BUILDD_EXECUTOR: 'cloud' })).toBe(true);
    expect(phaseLinesEnabled({})).toBe(false);
    expect(phaseLinesEnabled({ BUILDD_EXECUTOR: 'local' })).toBe(false);
  });

  test('emitPhase writes one line when enabled and nothing otherwise', () => {
    const out: string[] = [];
    emitPhase('install_end', { env: { BUILDD_EXECUTOR: 'cloud' }, now: () => 42, log: (l) => out.push(l) });
    emitPhase('install_end', { env: {}, now: () => 42, log: (l) => out.push(l) });
    expect(out).toEqual(['BUILDD_PHASE=install_end 42']);
  });
});

describe('clone phase lines from the real clone sites', () => {
  const { mkdtempSync, rmSync } = require('fs') as typeof import('fs');
  const { execSync } = require('child_process') as typeof import('child_process');
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');

  function capture(fn: () => void): string[] {
    const prev = process.env.BUILDD_EXECUTOR;
    const orig = console.log;
    const lines: string[] = [];
    process.env.BUILDD_EXECUTOR = 'cloud';
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    try { fn(); } finally {
      console.log = orig;
      if (prev === undefined) delete process.env.BUILDD_EXECUTOR; else process.env.BUILDD_EXECUTOR = prev;
    }
    return lines.filter(l => l.startsWith('BUILDD_PHASE=')).map(l => l.split(' ')[0]!);
  }

  test('ensureIsolatedClone brackets the clone, on success and on failure; an existing clone emits nothing', async () => {
    const { ensureIsolatedClone } = await import('../../src/workspace');
    const dir = mkdtempSync(join(tmpdir(), 'phase-clone-'));
    try {
      const src = join(dir, 'src');
      execSync(`git init -q "${src}"`);
      const root = join(dir, 'iso');
      expect(capture(() => ensureIsolatedClone({ id: 'ws-1', repo: src }, root))).toEqual(['BUILDD_PHASE=clone_start', 'BUILDD_PHASE=clone_end']);
      expect(capture(() => ensureIsolatedClone({ id: 'ws-1', repo: src }, root))).toEqual([]);
      expect(capture(() => {
        try { ensureIsolatedClone({ id: 'ws-2', repo: join(dir, 'missing') }, root); } catch { /* expected */ }
      })).toEqual(['BUILDD_PHASE=clone_start', 'BUILDD_PHASE=clone_end']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('timedPhase returns the value and rethrows', () => {
    const { timedPhase } = require('../../src/phase-lines') as typeof import('../../src/phase-lines');
    const lines: string[] = [];
    const opts = { env: { BUILDD_EXECUTOR: 'cloud' }, now: () => 1, log: (l: string) => lines.push(l) };
    expect(timedPhase('clone', () => 7, opts)).toBe(7);
    expect(() => timedPhase('install', () => { throw new Error('x'); }, opts)).toThrow('x');
    expect(lines).toEqual(['BUILDD_PHASE=clone_start 1', 'BUILDD_PHASE=clone_end 1', 'BUILDD_PHASE=install_start 1', 'BUILDD_PHASE=install_end 1']);
  });
});
