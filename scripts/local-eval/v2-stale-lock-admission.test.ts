import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROOT, admitOne, loadSuiteV2 } from './v2';

/**
 * term-recovery-stale-lock was rejected at admission on native Windows because
 * its verifier started a live process with the Unix-only `sleep`. These tests
 * run the real admission with a PATH that has `bun` and nothing else, which is
 * what a native Windows PATH looks like to the verifier.
 */
const c = loadSuiteV2(DEFAULT_ROOT).cases['term-recovery-stale-lock'];

describe('term-recovery-stale-lock verifier portability', () => {
  it('starts its live-lock process without any external Unix tool', () => {
    expect(c.files['verifier/check.ts']).not.toMatch(/\bsleep\b/);
  });

  it('is admitted when the only tools on PATH are bun and git (no sleep)', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'bun-only-'));
    const ev = mkdtempSync(join(tmpdir(), 'ev-'));
    const saved = process.env.PATH;
    try {
      mkdirSync(bin, { recursive: true });
      symlinkSync(process.execPath, join(bin, 'bun'));
      symlinkSync(Bun.which('git')!, join(bin, 'git')); // admission exports the agent tree with git; the verifier itself needs only bun
      process.env.PATH = bin;
      const r = await admitOne(c, ev);
      expect(r.gates.filter((g) => !g.ok)).toEqual([]);
      expect(r.admitted).toBe(true);
    } finally {
      process.env.PATH = saved;
      rmSync(bin, { recursive: true, force: true });
      rmSync(ev, { recursive: true, force: true });
    }
  }, 120_000);
});
