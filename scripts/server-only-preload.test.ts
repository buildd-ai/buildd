import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'bun';
import { dirname, join, resolve } from 'path';

// `packages/core/db/client.ts` carries `import 'server-only'` as a build-time trip
// wire, so that a client component which accidentally imports the DB layer fails
// `next build` instead of shipping a broken bundle (PR #2072).
//
// That specifier is resolved by its own package.json export condition, not by a
// runtime check: `react-server` -> no-op, `default` -> throws. Only Next's bundler
// sets that condition, so under the plain Bun runtime it throws unconditionally —
// including from legitimately server-side code. `bun test` was given a stub plugin
// and stayed green, which hid the fact that every DB-touching *script* (seeds,
// backfills, doctor, the retrieval eval) started crashing on import. The retrieval
// eval gate is where it finally surfaced, three days later.
//
// These cases must therefore spawn a real subprocess. Asserting anything from
// inside `bun test` would only re-check the test preload and pass regardless.
const REPO_ROOT = resolve(dirname(import.meta.path), '..');
const PROBE = join(REPO_ROOT, 'scripts/__fixtures__/db-import-probe.ts');
const CLIENT_THROW = /cannot be imported from a Client Component/i;

function runProbe(cwd: string) {
  const res = spawnSync({
    cmd: ['bun', 'run', PROBE],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // A stray DATABASE_URL must not change the outcome; the probe never connects.
    env: { ...process.env, NODE_ENV: 'production' },
  });
  return {
    code: res.exitCode,
    out: res.stdout.toString(),
    err: res.stderr.toString(),
  };
}

describe('server-only is stubbed for the plain Bun runtime', () => {
  it('lets a script at the repo root import the DB layer', () => {
    const { code, out, err } = runProbe(REPO_ROOT);
    expect(err).not.toMatch(CLIENT_THROW);
    expect(out).toContain('db-import-probe: ok');
    expect(code).toBe(0);
  });

  // CLAUDE.md tells contributors to `cd packages/core` for db:generate/db:migrate,
  // and package.json's seed:cue-connector does the same. Bun looks for bunfig.toml
  // in the cwd only — it does not walk up to the repo root — so the root config
  // alone leaves every subdirectory invocation broken.
  it('lets a script run from packages/core import the DB layer', () => {
    const { code, out, err } = runProbe(join(REPO_ROOT, 'packages/core'));
    expect(err).not.toMatch(CLIENT_THROW);
    expect(out).toContain('db-import-probe: ok');
    expect(code).toBe(0);
  });
});
