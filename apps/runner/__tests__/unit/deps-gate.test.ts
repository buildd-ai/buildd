/**
 * The Bash gate that lets a cloud session start while the deps install runs
 * behind it (deps-gate.ts; knowledge-base: buildd/design/cloud-runner-warm-handover.md §2).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/deps-gate.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  commandNeedsDeps,
  createDepsGateHook,
  DepsJob,
  depsWorkSettled,
  setDepsPrelude,
  depsPrelude,
  trackDepsWork,
  __resetDepsWork,
  DEPS_GATE_HOLD_MS,
  DEPS_GATE_HOOK_TIMEOUT_S,
  type DepsGateStats,
} from '../../src/deps-gate';
import type { InstallOutcome } from '../../src/git-operations';
import { RUNNER_DENIAL_MARKER } from '../../src/runner-denial';

const NEEDS = [
  'pnpm install',
  'npm test',
  'yarn build',
  'bun run test',
  'bunx tsc --noEmit',
  'npx vitest run src/a.test.ts',
  'node scripts/build.js',
  'turbo run build --filter=web',
  'tsc -p .',
  'vitest',
  'jest --ci',
  'next build',
  'make test',
  'cd packages/web && pnpm test',
  'git status && bun test',
  'CI=1 NODE_ENV=test pnpm -r build',
  'time npm run lint',
  'timeout 300 pnpm build',
  'env -i PATH=/bin node x.js',
  'cat out.txt | node -e "1"',
  './node_modules/.bin/eslint src',
  '/usr/local/bin/node --version',
  'echo $(node -p 1)',
  '(cd app; npm ci)',
];

const FREE = [
  'git status',
  'git log --oneline -5',
  'rg "needle" src',
  'ls -la',
  'cat package.json',
  'grep -rn "pnpm" docs',
  'sed -n 1,20p README.md',
  'echo "run pnpm install later"',
  'find . -name "*.ts"',
  'git commit -m "bump node version"',
  'gh pr view 12',
  'wc -l src/*.ts',
  '',
];

describe('commandNeedsDeps — one table, both directions', () => {
  for (const c of NEEDS) test(`needs deps: ${c}`, () => expect(commandNeedsDeps(c)).toBe(true));
  for (const c of FREE) test(`never waits: ${JSON.stringify(c)}`, () => expect(commandNeedsDeps(c)).toBe(false));
});

// ── Gate ─────────────────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }) as any;
const signal = () => new AbortController().signal;
const freshStats = (): DepsGateStats => ({ firstGatedToolAt: null, gateWaitMs: 0, holds: 0, denials: 0 });
const OK: InstallOutcome = { status: 'ok', dirs: ['.'] };
const FAILED: InstallOutcome = { status: 'failed', dir: '.', failure: 'lockfile-drift', message: 'ERR_PNPM_OUTDATED_LOCKFILE' };

beforeEach(() => __resetDepsWork());

describe('createDepsGateHook', () => {
  test('the SDK hook timeout outlasts the hold, so the cap is what decides', () => {
    expect(DEPS_GATE_HOOK_TIMEOUT_S * 1000).toBeGreaterThan(DEPS_GATE_HOLD_MS);
  });

  test('holds a deps command while the install runs, then lets it run once it succeeds', async () => {
    const install = deferred<InstallOutcome>();
    const job = new DepsJob(() => install.promise);
    const stats = freshStats();
    const hook = createDepsGateHook(job, stats, { holdMs: 5_000 });

    let settled = false;
    const call = hook(bash('pnpm test'), 't1', { signal: signal() }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // held
    expect(stats.holds).toBe(1);
    expect(stats.firstGatedToolAt).not.toBeNull();

    install.resolve(OK);
    expect(await call).toEqual({}); // allowed, no denial
    expect(stats.gateWaitMs).toBeGreaterThanOrEqual(15);
    expect(stats.denials).toBe(0);
  });

  test('a failed install releases the gate too, and tells the agent once', async () => {
    const install = deferred<InstallOutcome>();
    const job = new DepsJob(() => install.promise);
    const seen: InstallOutcome[] = [];
    const hook = createDepsGateHook(job, freshStats(), { holdMs: 5_000, onFailureSeen: (o) => seen.push(o) });

    const call = hook(bash('npm run build'), 't1', { signal: signal() });
    install.resolve(FAILED);
    const r = await call as any;
    expect(r.hookSpecificOutput?.permissionDecision).toBeUndefined(); // not denied
    expect(r.hookSpecificOutput?.additionalContext).toContain('lockfile-drift');
    expect(seen).toEqual([FAILED]);
    // The next one passes plainly.
    expect(await hook(bash('npm run build'), 't2', { signal: signal() })).toEqual({});
    expect(seen.length).toBe(1);
  });

  test('a thrown install is a failed outcome, not a stuck gate', async () => {
    const job = new DepsJob(async () => { throw new Error('spawn pnpm ENOENT'); });
    const r = await job.promise;
    expect(r).toMatchObject({ status: 'failed', failure: 'unknown' });
  });

  test('past the cap the command is denied with how long it has been, as a runner denial', async () => {
    let t = 1_000_000;
    const job = new DepsJob(() => new Promise(() => {}), () => t);
    const stats = freshStats();
    const hook = createDepsGateHook(job, stats, { holdMs: 30, now: () => t });
    t += 73_000;
    const r = await hook(bash('turbo build'), 't1', { signal: signal() }) as any;
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain(RUNNER_DENIAL_MARKER);
    expect(r.hookSpecificOutput.permissionDecisionReason).toContain('dependencies still installing (73 s so far)');
    expect(stats.denials).toBe(1);
  });

  test('commands that do not need deps, and non-Bash tools, never wait', async () => {
    const job = new DepsJob(() => new Promise(() => {}));
    const stats = freshStats();
    const hook = createDepsGateHook(job, stats, { holdMs: 60_000 });
    expect(await hook(bash('git status'), 't1', { signal: signal() })).toEqual({});
    expect(await hook(bash('rg foo'), 't2', { signal: signal() })).toEqual({});
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } } as any, 't3', { signal: signal() })).toEqual({});
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'pnpm' } } as any, 't4', { signal: signal() })).toEqual({});
    expect(stats).toEqual(freshStats());
  });

  test('after the install, deps commands pass immediately but still record when the agent first needed them', async () => {
    const job = new DepsJob(async () => OK);
    await job.promise;
    const stats = freshStats();
    const hook = createDepsGateHook(job, stats, { now: () => 42 });
    expect(await hook(bash('bun test'), 't1', { signal: signal() })).toEqual({});
    expect(stats).toEqual({ firstGatedToolAt: 42, gateWaitMs: 0, holds: 0, denials: 0 });
  });

  test('an aborted session stops holding', async () => {
    const job = new DepsJob(() => new Promise(() => {}));
    const hook = createDepsGateHook(job, freshStats(), { holdMs: 60_000 });
    const ac = new AbortController();
    const call = hook(bash('pnpm build'), 't1', { signal: ac.signal });
    ac.abort();
    const r = await call as any;
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('background deps work', () => {
  test('depsWorkSettled waits for the prelude and every job, including ones started meanwhile', async () => {
    const cache = deferred<void>();
    setDepsPrelude(cache.promise);
    const install = deferred<InstallOutcome>();
    let done = false;
    const settled = depsWorkSettled().then(() => { done = true; });
    const job = new DepsJob(async () => { await depsPrelude(); return install.promise; });
    cache.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    install.resolve(OK);
    await job.promise;
    await settled;
    expect(done).toBe(true);
  });

  test('a rejected tracked promise does not wedge the wait', async () => {
    const p = Promise.reject(new Error('x'));
    p.catch(() => {});
    trackDepsWork(p);
    await depsWorkSettled();
  });

  test('no prelude: the install does not wait for anything', async () => {
    await depsPrelude();
  });
});
