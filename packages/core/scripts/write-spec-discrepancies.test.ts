/**
 * End-to-end tests for the Tier-2 ledger writer CLI's DATABASE_URL guard.
 *
 * Regression for the stranded-card investigation (docs/design/spec-conformance.md
 * §7 Part B): the script used to fall back to a silent dry run whenever
 * DATABASE_URL was unset, even when --dry-run was never requested — a write
 * job that no-ops without saying so. Spawns the real script (no mocking) so
 * this exercises actual argv parsing and the real exit code / stderr, not a
 * re-implementation of the guard.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/scripts/write-spec-discrepancies.test.ts
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'write-spec-discrepancies.ts');

async function run(args: string[], envOverrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.DATABASE_URL;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe('write-spec-discrepancies.ts — DATABASE_URL guard', () => {
  test('no DATABASE_URL and no --dry-run: fails loudly rather than silently writing nothing', async () => {
    const { code, stderr } = await run([]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('DATABASE_URL');
    expect(stderr).toContain('--dry-run');
  });

  test('--dry-run explicitly requested: succeeds and reports a dry run, never mistaken for a write', async () => {
    const { code, stdout, stderr } = await run(['--dry-run']);
    expect(code).toBe(0);
    expect(stdout).toContain('this run would insert');
    expect(stdout).not.toContain('Ledger writes:');
    expect(stderr).not.toContain('DATABASE_URL is not set');
  });

  test('DATABASE_URL set but no --dry-run and no --workspace-id: still fails (existing guard), not a silent dry run', async () => {
    const { code, stderr } = await run([], { DATABASE_URL: 'postgres://example-not-real/db' });
    expect(code).not.toBe(0);
    expect(stderr).toContain('--workspace-id');
  });
});
