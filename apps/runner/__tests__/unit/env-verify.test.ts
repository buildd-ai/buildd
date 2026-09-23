import { describe, it, expect } from 'bun:test';
import {
  parseManifest,
  autoDetectManifest,
  parseRuntime,
  planSteps,
  executeSteps,
  runEnvVerify,
  runProvisionGate,
  clearProvisionGateCache,
  MANIFEST_PATH,
  type EnvManifest,
  type FsProbe,
  type CommandRunner,
  type CommandOutcome,
} from '../../src/env-verify';

// ─── parseManifest ───────────────────────────────────────────────────────────

describe('parseManifest', () => {
  it('parses a full manifest', () => {
    const m = parseManifest(`
toolchain:
  runtime: bun@1.3.14
install:
  command: bun install --frozen-lockfile
env:
  required: [DATABASE_URL, VOYAGE_API_KEY]
readiness:
  command: bun run scripts/check-specs.ts --check
  timeout: 180
provision:
  - git config core.hooksPath .githooks
`);
    expect(m).toEqual({
      toolchain: { runtime: 'bun@1.3.14' },
      install: { command: 'bun install --frozen-lockfile' },
      env: { required: ['DATABASE_URL', 'VOYAGE_API_KEY'] },
      readiness: { command: 'bun run scripts/check-specs.ts --check', timeout: 180 },
      provision: ['git config core.hooksPath .githooks'],
    });
  });

  it('ignores unknown keys and partial sections', () => {
    const m = parseManifest(`
toolchain:
  runtime: node@20
somethingElse: true
env: {}
`);
    expect(m).toEqual({ toolchain: { runtime: 'node@20' } });
  });

  it('returns null on malformed YAML rather than throwing', () => {
    expect(parseManifest(':\n  - [unbalanced')).toBeNull();
  });

  it('returns empty manifest for an empty-but-valid doc section set', () => {
    // A doc with only non-recognized content yields {} (no steps later).
    expect(parseManifest('unrelated: 1')).toEqual({});
  });
});

// ─── autoDetectManifest ──────────────────────────────────────────────────────

describe('autoDetectManifest', () => {
  const detect = (present: string[]) =>
    autoDetectManifest('/repo', (p) => present.includes(p));

  it('detects bun from bun.lock', () => {
    expect(detect(['bun.lock'])).toEqual({
      toolchain: { runtime: 'bun' },
      install: { command: 'bun install --frozen-lockfile' },
    });
  });

  it('detects npm from package-lock.json', () => {
    expect(detect(['package-lock.json'])?.install?.command).toBe('npm ci');
  });

  it('detects uv from uv.lock', () => {
    expect(detect(['uv.lock'])?.install?.command).toBe('uv sync --frozen');
  });

  it('prefers the first matching detector (bun over npm)', () => {
    expect(detect(['bun.lock', 'package-lock.json'])?.toolchain?.runtime).toBe('bun');
  });

  it('returns null when nothing recognizable is present', () => {
    expect(detect(['README.md'])).toBeNull();
  });
});

// ─── parseRuntime ────────────────────────────────────────────────────────────

describe('parseRuntime', () => {
  it('splits tool@version', () => {
    expect(parseRuntime('bun@1.3.14')).toEqual({ tool: 'bun', version: '1.3.14' });
  });
  it('handles a bare tool', () => {
    expect(parseRuntime('go')).toEqual({ tool: 'go' });
  });
});

// ─── planSteps ───────────────────────────────────────────────────────────────

describe('planSteps', () => {
  it('orders steps toolchain → install → env → provision → readiness', () => {
    const m: EnvManifest = {
      toolchain: { runtime: 'bun@1.3.14' },
      install: { command: 'bun install' },
      env: { required: ['DATABASE_URL'] },
      readiness: { command: 'tsc --noEmit', timeout: 90 },
      provision: ['git config core.hooksPath .githooks'],
    };
    expect(planSteps(m).map((s) => s.phase)).toEqual([
      'toolchain', 'install', 'env', 'provision', 'readiness',
    ]);
  });

  it('converts readiness timeout seconds → ms', () => {
    const [step] = planSteps({ readiness: { command: 'x', timeout: 90 } });
    expect(step.timeoutMs).toBe(90_000);
  });

  it('emits one step per provision command', () => {
    const steps = planSteps({ provision: ['a', 'b', 'c'] });
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => s.phase === 'provision')).toBe(true);
  });

  it('produces no steps for an empty manifest', () => {
    expect(planSteps({})).toEqual([]);
  });
});

// ─── executeSteps ────────────────────────────────────────────────────────────

const now = (() => { let t = 0; return () => (t += 5); })();

/** A runner that returns code 0 unless the command matches a failure pattern. */
function fakeRunner(failOn: RegExp | null = null): CommandRunner {
  return (command): CommandOutcome =>
    failOn && failOn.test(command)
      ? { code: 1, stdout: '', stderr: `boom: ${command}\nlast line of error` }
      : { code: 0, stdout: 'ok', stderr: '' };
}

describe('executeSteps', () => {
  it('passes env-check when all vars are present', async () => {
    const steps = planSteps({ env: { required: ['A', 'B'] } });
    const [r] = await executeSteps(steps, { root: '/r', env: { A: '1', B: '2' }, runCommand: fakeRunner(), now });
    expect(r.status).toBe('ok');
  });

  it('fails env-check and names the missing vars', async () => {
    const steps = planSteps({ env: { required: ['A', 'B', 'C'] } });
    const [r] = await executeSteps(steps, { root: '/r', env: { A: '1' }, runCommand: fakeRunner(), now });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('B');
    expect(r.message).toContain('C');
    expect(r.message).not.toContain(' A');
  });

  it('treats empty-string env vars as missing', async () => {
    const steps = planSteps({ env: { required: ['A'] } });
    const [r] = await executeSteps(steps, { root: '/r', env: { A: '' }, runCommand: fakeRunner(), now });
    expect(r.status).toBe('fail');
  });

  it('tool-check passes when `command -v` exits 0', async () => {
    const steps = planSteps({ toolchain: { runtime: 'bun@1.3' } });
    const [r] = await executeSteps(steps, { root: '/r', env: {}, runCommand: fakeRunner(), now });
    expect(r.status).toBe('ok');
  });

  it('tool-check fails when the tool is not on PATH', async () => {
    const steps = planSteps({ toolchain: { runtime: 'ghc' } });
    const [r] = await executeSteps(steps, { root: '/r', env: {}, runCommand: fakeRunner(/command -v ghc/), now });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('ghc');
  });

  it('stops at the first failure and marks later steps skipped', async () => {
    const m: EnvManifest = {
      install: { command: 'bun install' },
      readiness: { command: 'tsc' },
    };
    const results = await executeSteps(planSteps(m), {
      root: '/r', env: {}, runCommand: fakeRunner(/bun install/), now,
    });
    expect(results.map((r) => r.status)).toEqual(['fail', 'skip']);
    expect(results[1].message).toContain('earlier phase failed');
  });

  it('summarizes a failing command with its exit code and first error line', async () => {
    const results = await executeSteps(planSteps({ install: { command: 'bun install' } }), {
      root: '/r', env: {}, runCommand: fakeRunner(/bun install/), now,
    });
    expect(results[0].message).toContain('exit 1');
    expect(results[0].message).toContain('boom: bun install');
  });

  it('reports the first real error, not a trailing summary line (regression: check-specs.ts prints its summary last)', async () => {
    // Mirrors scripts/check-specs.ts --check: every real content error is
    // printed as it's found, and only afterwards — if the ONLY remaining
    // problem is a stale generated index — does a summary/trailer line get
    // appended. failMessage used to take the LAST stderr line, so a real
    // content error sitting earlier in the stream was masked by whatever
    // trailed it.
    const specLintRunner: CommandRunner = () => ({
      code: 1,
      stdout: '',
      stderr: [
        '✖ docs/specs/foo.md: frontmatter missing `summary`',
        '✖ docs/specs/foo.md: code surface path does not exist: apps/web/src/lib/gone.ts',
        '✖ docs/specs/INDEX.md is stale — run `bun run specs:check` to regenerate',
        '21 specs · 3 error(s) · 0 warning(s)',
      ].join('\n'),
    });
    const steps = planSteps({ readiness: { command: 'bun run scripts/check-specs.ts --check' } });
    const [r] = await executeSteps(steps, { root: '/r', env: {}, runCommand: specLintRunner, now });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('frontmatter missing `summary`');
    expect(r.message).not.toContain('is stale');
    expect(r.message).not.toContain('3 error(s)');
  });

  it('readiness exit code 2 is a non-blocking warn, not a fail', async () => {
    const advisoryRunner: CommandRunner = () => ({ code: 2, stdout: '', stderr: 'exit 2: ✖ docs/specs/INDEX.md is stale — run `bun run specs:check` to regenerate' });
    const steps = planSteps({ readiness: { command: 'bun run scripts/check-specs.ts --check' } });
    const [r] = await executeSteps(steps, { root: '/r', env: {}, runCommand: advisoryRunner, now });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('docs/specs/INDEX.md is stale');
  });

  it('exit code 2 outside the readiness phase is still a genuine failure', async () => {
    // The convention is readiness-only: a provision/install step returning 2
    // means whatever that command means by 2, not "advisory".
    const advisoryRunner: CommandRunner = () => ({ code: 2, stdout: '', stderr: 'boom' });
    const steps = planSteps({ install: { command: 'bun install' } });
    const [r] = await executeSteps(steps, { root: '/r', env: {}, runCommand: advisoryRunner, now });
    expect(r.status).toBe('fail');
  });

  it('a warn step does not abort later phases the way a fail does', async () => {
    const advisoryRunner: CommandRunner = (command) =>
      /check-specs/.test(command)
        ? { code: 2, stdout: '', stderr: 'stale index' }
        : { code: 0, stdout: 'ok', stderr: '' };
    const m: EnvManifest = {
      provision: ['git config core.hooksPath .githooks'],
      readiness: { command: 'bun run scripts/check-specs.ts --check' },
    };
    // provision runs BEFORE readiness in planSteps order, so this also proves a
    // later 'warn' never retroactively matters — included for completeness.
    const results = await executeSteps(planSteps(m), { root: '/r', env: {}, runCommand: advisoryRunner, now });
    expect(results.map((r) => r.status)).toEqual(['ok', 'warn']);
  });

  it('skips phases named in skipPhases without running or failing them', async () => {
    const m: EnvManifest = {
      install: { command: 'bun install --frozen-lockfile' },
      readiness: { command: 'tsc' },
    };
    // fakeRunner would FAIL install, but it's skipped → install never runs, readiness passes.
    const results = await executeSteps(planSteps(m), {
      root: '/r', env: {}, runCommand: fakeRunner(/bun install/), skipPhases: ['install'], now,
    });
    const install = results.find((r) => r.phase === 'install')!;
    const readiness = results.find((r) => r.phase === 'readiness')!;
    expect(install.status).toBe('skip');
    expect(install.message).toContain('handled by runner');
    expect(readiness.status).toBe('ok');
  });
});

// ─── runEnvVerify (integration of the pure pieces, no real shell) ────────────

describe('runEnvVerify', () => {
  it('reports ok with source "none" when there is nothing to verify', async () => {
    // /nonexistent has no manifest and no lockfiles → resolveManifest returns none.
    const report = await runEnvVerify({ root: '/nonexistent-repo-xyz', runCommand: fakeRunner(), now });
    expect(report.source).toBe('none');
    expect(report.ok).toBe(true);
    expect(report.steps).toHaveLength(0);
  });
});

// ─── runProvisionGate (runner integration decision) ──────────────────────────

/**
 * In-memory filesystem probe — decouples these tests from the real `fs`, which
 * other runner unit tests mock globally (Bun's mock.module leaks across files).
 * `files` maps repo-relative paths → contents; a declared manifest lives at
 * MANIFEST_PATH.
 */
function fakeFs(files: Record<string, string>): FsProbe {
  return {
    exists: (rel) => rel in files,
    read: (rel) => files[rel] ?? '',
  };
}

describe('runProvisionGate', () => {
  it('does NOT enforce when no manifest is declared (auto-detect stays advisory)', async () => {
    const gate = await runProvisionGate({ root: '/r', env: {}, fs: fakeFs({}), runCommand: fakeRunner(), now });
    expect(gate.enforced).toBe(false);
    expect(gate.ok).toBe(true);
    expect(gate.steps).toHaveLength(0);
  });

  it('does NOT enforce for an auto-detected plan (lockfile only, no manifest)', async () => {
    const gate = await runProvisionGate({
      root: '/r', env: {}, fs: fakeFs({ 'bun.lock': '' }), runCommand: fakeRunner(/anything/), now,
    });
    // resolveManifest → source 'auto-detected' → gate must not block.
    expect(gate.enforced).toBe(false);
    expect(gate.ok).toBe(true);
  });

  it('enforces and passes a declared manifest whose steps succeed', async () => {
    const gate = await runProvisionGate({
      root: '/r', env: {}, fs: fakeFs({ [MANIFEST_PATH]: 'readiness:\n  command: echo ok\n' }),
      runCommand: fakeRunner(), now,
    });
    expect(gate.enforced).toBe(true);
    expect(gate.ok).toBe(true);
  });

  it('enforces and BLOCKS with a structured reason when a declared step fails', async () => {
    const gate = await runProvisionGate({
      root: '/r', env: {},
      fs: fakeFs({ [MANIFEST_PATH]: 'env:\n  required: [MISSING_VAR_XYZ]\nreadiness:\n  command: echo later\n' }),
      runCommand: fakeRunner(), now,
    });
    expect(gate.enforced).toBe(true);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('Provision failed [env]');
    expect(gate.reason).toContain('MISSING_VAR_XYZ');
    // downstream readiness never ran
    expect(gate.steps.find((s) => s.phase === 'readiness')!.status).toBe('skip');
  });

  it('emits a stable machine-readable failure code keyed to the failing phase', async () => {
    const env = await runProvisionGate({
      root: '/r', env: {}, fs: fakeFs({ [MANIFEST_PATH]: 'env:\n  required: [X]\n' }),
      runCommand: fakeRunner(), now,
    });
    expect(env.failure).toEqual({ code: 'provision_env_missing', phase: 'env', message: 'missing: X' });

    const tool = await runProvisionGate({
      root: '/r', env: {}, fs: fakeFs({ [MANIFEST_PATH]: 'toolchain:\n  runtime: ghc\n' }),
      runCommand: fakeRunner(/command -v ghc/), now,
    });
    expect(tool.failure?.code).toBe('provision_toolchain_missing');
    expect(tool.failure?.phase).toBe('toolchain');

    const ready = await runProvisionGate({
      root: '/r', env: {}, fs: fakeFs({ [MANIFEST_PATH]: 'readiness:\n  command: tsc\n' }),
      runCommand: fakeRunner(/tsc/), now,
    });
    expect(ready.failure?.code).toBe('provision_readiness_failed');
  });

  it('leaves failure undefined on a passing gate', async () => {
    const gate = await runProvisionGate({
      root: '/r', env: {}, fs: fakeFs({ [MANIFEST_PATH]: 'readiness:\n  command: echo ok\n' }),
      runCommand: fakeRunner(), now,
    });
    expect(gate.ok).toBe(true);
    expect(gate.failure).toBeUndefined();
  });

  it('validates env.required against the injected env, not process.env (Phase 4)', async () => {
    // A secret-backed var delivered via the claim lands in the worker's assembled
    // env (cleanEnv), not process.env. The gate must pass when it's present there.
    const manifest = { [MANIFEST_PATH]: 'env:\n  required: [VOYAGE_API_KEY]\n' };
    const injected = { VOYAGE_API_KEY: 'secret-from-claim' }; // NOT in process.env
    const pass = await runProvisionGate({ root: '/r', env: injected, fs: fakeFs(manifest), runCommand: fakeRunner(), now });
    expect(pass.enforced).toBe(true);
    expect(pass.ok).toBe(true);
    // …and blocks when the secret wasn't delivered (absent from the injected env).
    const fail = await runProvisionGate({ root: '/r', env: {}, fs: fakeFs(manifest), runCommand: fakeRunner(), now });
    expect(fail.ok).toBe(false);
    expect(fail.reason).toContain('VOYAGE_API_KEY');
  });

  it('does not block a worker on a readiness exit-2 advisory (stale generated docs, not this task\'s problem)', async () => {
    const advisoryRunner: CommandRunner = () => ({ code: 2, stdout: '', stderr: 'exit 2: ✖ docs/specs/INDEX.md is stale — run `bun run specs:check` to regenerate' });
    const gate = await runProvisionGate({
      root: '/r', env: {},
      fs: fakeFs({ [MANIFEST_PATH]: 'readiness:\n  command: bun run scripts/check-specs.ts --check\n' }),
      runCommand: advisoryRunner, now,
    });
    expect(gate.enforced).toBe(true);
    expect(gate.ok).toBe(true); // proceeds — the agent starts, no worker is killed
    expect(gate.reason).toBeUndefined();
    expect(gate.failure).toBeUndefined();
    expect(gate.steps.find((s) => s.phase === 'readiness')!.status).toBe('warn');
  });

  it('a genuine readiness failure (exit 1) still blocks exactly as before', async () => {
    const failingRunner: CommandRunner = () => ({ code: 1, stdout: '', stderr: 'a real spec content error' });
    const gate = await runProvisionGate({
      root: '/r', env: {},
      fs: fakeFs({ [MANIFEST_PATH]: 'readiness:\n  command: bun run scripts/check-specs.ts --check\n' }),
      runCommand: failingRunner, now,
    });
    expect(gate.ok).toBe(false);
    expect(gate.failure?.code).toBe('provision_readiness_failed');
  });

  it('honors skipPhases so the runner-owned install is not re-run', async () => {
    const gate = await runProvisionGate({
      root: '/r', env: {},
      fs: fakeFs({ [MANIFEST_PATH]: 'install:\n  command: bun install --frozen-lockfile\nreadiness:\n  command: echo ready\n' }),
      // install would fail via fakeRunner, but skipPhases drops it → gate passes on readiness.
      runCommand: fakeRunner(/bun install/), skipPhases: ['install'], now,
    });
    expect(gate.ok).toBe(true);
    expect(gate.steps.find((s) => s.phase === 'install')!.status).toBe('skip');
  });
});

// ─── warm gate cache ─────────────────────────────────────────────────────────

describe('runProvisionGate warm cache', () => {
  const READY = { [MANIFEST_PATH]: 'readiness:\n  command: echo ok\n' };

  /** A runner that counts how many commands it actually executed. */
  function countingRunner() {
    let calls = 0;
    const run: CommandRunner = () => { calls++; return { code: 0, stdout: '', stderr: '' }; };
    return { run, calls: () => calls };
  }

  it('reuses a passing result for the same commit + manifest (skips re-running steps)', async () => {
    clearProvisionGateCache();
    const r = countingRunner();
    const opts = { root: '/r', env: {}, fs: fakeFs(READY), runCommand: r.run, commit: 'abc123' };
    const first = await runProvisionGate(opts);
    expect(first.ok).toBe(true);
    expect(first.cached).toBeUndefined();
    const firstCalls = r.calls();
    expect(firstCalls).toBeGreaterThan(0);

    const second = await runProvisionGate(opts);
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
    expect(r.calls()).toBe(firstCalls); // no additional command executed
  });

  it('does NOT cache when no commit is supplied', async () => {
    clearProvisionGateCache();
    const a = await runProvisionGate({ root: '/r', env: {}, fs: fakeFs(READY), runCommand: fakeRunner() });
    const b = await runProvisionGate({ root: '/r', env: {}, fs: fakeFs(READY), runCommand: fakeRunner() });
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBeUndefined();
  });

  it('does NOT cache an env-dependent manifest (env.required present)', async () => {
    clearProvisionGateCache();
    const fs = fakeFs({ [MANIFEST_PATH]: 'env:\n  required: [X]\nreadiness:\n  command: echo ok\n' });
    const opts = { root: '/r', env: { X: '1' }, fs, runCommand: fakeRunner(), commit: 'abc123' };
    await runProvisionGate(opts);
    const second = await runProvisionGate(opts);
    expect(second.cached).toBeUndefined(); // must re-check — result depends on injected secrets
  });

  it('never caches a failure', async () => {
    clearProvisionGateCache();
    const fs = fakeFs({ [MANIFEST_PATH]: 'readiness:\n  command: flaky\n' });
    const opts = { root: '/r', env: {}, fs, runCommand: fakeRunner(/flaky/), commit: 'abc123' };
    const fail = await runProvisionGate(opts);
    expect(fail.ok).toBe(false);
    // Same commit now "passes" (issue fixed) — must re-run, not serve a stale pass.
    const retry = await runProvisionGate({ ...opts, runCommand: fakeRunner() });
    expect(retry.ok).toBe(true);
    expect(retry.cached).toBeUndefined();
  });

  it('expires cached passes after the TTL', async () => {
    clearProvisionGateCache();
    let t = 0;
    const clock = () => t;
    const opts = { root: '/r', env: {}, fs: fakeFs(READY), runCommand: fakeRunner(), commit: 'abc123', now: clock };
    await runProvisionGate(opts);
    t += 11 * 60 * 1000; // advance past the 10-min TTL
    const after = await runProvisionGate(opts);
    expect(after.cached).toBeUndefined(); // stale → re-run
  });

  it('keys on the commit — a different base misses', async () => {
    clearProvisionGateCache();
    await runProvisionGate({ root: '/r', env: {}, fs: fakeFs(READY), runCommand: fakeRunner(), commit: 'aaa' });
    const other = await runProvisionGate({ root: '/r', env: {}, fs: fakeFs(READY), runCommand: fakeRunner(), commit: 'bbb' });
    expect(other.cached).toBeUndefined();
  });

  it('still runs install on a cache hit — the cache key is (commit, manifest), not the worktree path, so a second worktree cut from an already-verified base has no node_modules of its own unless install actually runs there', async () => {
    clearProvisionGateCache();
    const withInstall = fakeFs({
      [MANIFEST_PATH]: 'install:\n  command: bun install --frozen-lockfile\nreadiness:\n  command: echo ok\n',
    });
    const r = countingRunner();
    // First worktree off commit 'abc123': runs install for real.
    const first = await runProvisionGate({ root: '/worktree-a', env: {}, fs: withInstall, runCommand: r.run, commit: 'abc123' });
    expect(first.ok).toBe(true);
    expect(first.steps.find((s) => s.phase === 'install')!.status).toBe('ok');
    const callsAfterFirst = r.calls();

    // Second worktree, SAME base commit + manifest, but a different directory on
    // disk — the gate must still install here even though the pass is cached.
    const second = await runProvisionGate({ root: '/worktree-b', env: {}, fs: withInstall, runCommand: r.run, commit: 'abc123' });
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
    expect(second.steps.find((s) => s.phase === 'install')!.status).toBe('ok');
    // readiness is the only phase actually skipped by the cache hit.
    expect(second.steps.find((s) => s.phase === 'readiness')!.status).toBe('skip');
    expect(r.calls()).toBeGreaterThan(callsAfterFirst);
  });
});
