import { describe, it, expect } from 'bun:test';
import {
  parseManifest,
  autoDetectManifest,
  parseRuntime,
  planSteps,
  executeSteps,
  runEnvVerify,
  runProvisionGate,
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

  it('summarizes a failing command with its exit code and last error line', async () => {
    const results = await executeSteps(planSteps({ install: { command: 'bun install' } }), {
      root: '/r', env: {}, runCommand: fakeRunner(/bun install/), now,
    });
    expect(results[0].message).toContain('exit 1');
    expect(results[0].message).toContain('last line of error');
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
