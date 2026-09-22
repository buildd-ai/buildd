/**
 * Regression: the scip probe's real invocation chain (env override → hoisted
 * node_modules/.bin → PATH → `npx --no-install` as a last resort) had zero
 * test coverage — every existing scip-runner test injects `invoke` directly and
 * never exercises `defaultInvoke`'s own resolution logic. Measured on the fleet,
 * the probe skips roughly 80% of the time because `@sourcegraph/scip-typescript`
 * was a devDependency (now moved to `dependencies` in apps/runner/package.json,
 * so a production-only install still gets the binary) — the `npx --no-install`
 * fallback ran almost every time, and a failure there collapsed to one generic
 * "unavailable or failed" message naming only the last attempt, discarding why
 * the earlier, more informative attempts (hoisted bin, PATH) also failed.
 *
 * `invokeAttempts`/`formatInvokeFailure` are extracted so the ordering, the
 * labels, and the final failure message (used as `ScipRunResult.skippedReason`,
 * which full-ingest.ts threads onto the job's stats) are unit-testable without
 * mocking `execFileSync`.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/knowledge-scip-runner-invoke.test.ts
 */
import { describe, it, expect } from 'bun:test';
import { invokeAttempts, formatInvokeFailure } from '../knowledge-store/scip-runner';

const INDEX_ARGS = ['index', '--output', '/tmp/out.scip'];

describe('invokeAttempts', () => {
  it('always includes PATH and the npx last-resort fallback, in that order, with no override or local bin', () => {
    const attempts = invokeAttempts({}, null, INDEX_ARGS);
    expect(attempts.map(a => a.cmd)).toEqual(['scip-typescript', 'npx']);
    expect(attempts[1].argv).toEqual(['--no-install', '@sourcegraph/scip-typescript', ...INDEX_ARGS]);
    expect(attempts[1].label).toContain('npx --no-install');
    expect(attempts[1].label).toContain('last resort');
  });

  it('tries SCIP_TYPESCRIPT_BIN first when set, before the hoisted local bin', () => {
    const attempts = invokeAttempts(
      { SCIP_TYPESCRIPT_BIN: '/opt/bin/scip-typescript' },
      '/repo/node_modules/.bin/scip-typescript',
      INDEX_ARGS,
    );
    expect(attempts.map(a => a.cmd)).toEqual([
      '/opt/bin/scip-typescript',
      '/repo/node_modules/.bin/scip-typescript',
      'scip-typescript',
      'npx',
    ]);
    expect(attempts[0].label).toContain('SCIP_TYPESCRIPT_BIN');
  });

  it('tries the hoisted local bin before falling through to PATH/npx', () => {
    const attempts = invokeAttempts({}, '/repo/node_modules/.bin/scip-typescript', INDEX_ARGS);
    expect(attempts.map(a => a.cmd)).toEqual(['/repo/node_modules/.bin/scip-typescript', 'scip-typescript', 'npx']);
  });
});

describe('formatInvokeFailure', () => {
  it('names every attempted resolution and its own failure reason, not just the last one', () => {
    const attempts = invokeAttempts({}, '/repo/node_modules/.bin/scip-typescript', INDEX_ARGS);
    const failures = [
      'hoisted node_modules/.bin (/repo/node_modules/.bin/scip-typescript): ENOENT',
      'scip-typescript on PATH: command not found',
      'npx --no-install @sourcegraph/scip-typescript (last resort): npm error 404',
    ];
    const msg = formatInvokeFailure(attempts, failures);
    expect(msg).toContain('3 resolution attempt(s)');
    expect(msg).toContain('ENOENT');
    expect(msg).toContain('command not found');
    expect(msg).toContain('npm error 404');
  });
});
