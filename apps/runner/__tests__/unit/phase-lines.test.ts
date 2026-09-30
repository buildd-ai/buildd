import { describe, expect, test } from 'bun:test';
import { PHASE_LINE_PREFIX, RUN_PHASES, emitPhase, formatPhaseLine, phaseLinesEnabled } from '../../src/phase-lines';

describe('phase lines', () => {
  test('format: BUILDD_PHASE=<phase> <epoch ms>', () => {
    expect(PHASE_LINE_PREFIX).toBe('BUILDD_PHASE=');
    expect(formatPhaseLine('clone_start', 1_700_000_000_123)).toBe('BUILDD_PHASE=clone_start 1700000000123');
    expect(RUN_PHASES).toEqual(['clone_start', 'clone_end', 'install_start', 'install_end']);
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
