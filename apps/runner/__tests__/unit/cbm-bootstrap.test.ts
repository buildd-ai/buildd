import { describe, it, expect } from 'bun:test';
import {
  runCbmBootstrap,
  resolveCbmIndexWaitMs,
  stopBackgroundCbmIndex,
  CBM_INDEX_WAIT_MS,
} from '../../src/cbm-bootstrap';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeCbmConfig() {
  return {
    command: '/opt/buildd/bin/codebase-memory-mcp',
    args: ['mcp'],
    env: {
      CBM_CACHE_DIR: '/tmp/cbm',
      CBM_ALLOWED_ROOT: '__WORKSPACE_DIR__',
      CBM_AUTO_WATCH: 'false',
      CBM_LOG_LEVEL: 'warn',
    },
  };
}

// Fake spawn that exits immediately with code 0
function makeSuccessSpawn(delayMs = 0) {
  return (_cmd: string, _args: string[], _opts: any) => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).kill = () => {};
    if (delayMs > 0) {
      setTimeout(() => proc.emit('close', 0), delayMs);
    } else {
      Promise.resolve().then(() => proc.emit('close', 0));
    }
    return proc;
  };
}

// Fake spawn that exits immediately with a non-zero code
function makeFailSpawn(exitCode: number) {
  return (_cmd: string, _args: string[], _opts: any) => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).kill = () => {};
    Promise.resolve().then(() => proc.emit('close', exitCode));
    return proc;
  };
}

// Fake spawn that emits an error event
function makeErrorSpawn(errorMessage: string) {
  return (_cmd: string, _args: string[], _opts: any) => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).kill = () => {};
    Promise.resolve().then(() => proc.emit('error', new Error(errorMessage)));
    return proc;
  };
}

// Fake spawn for an index that is still running when the wait budget expires.
//
// Exposes the child so a test can drive what happens AFTER the budget — the whole
// point of backgrounding is that the process outlives the wait, so "what the child
// does next" is now observable behaviour rather than something the timer ends.
function makeHangSpawn() {
  const { EventEmitter } = require('events');
  const proc = new EventEmitter();
  (proc as any).stdout = new EventEmitter();
  (proc as any).stderr = new EventEmitter();
  const killSignals: (string | undefined)[] = [];
  let unrefCount = 0;
  (proc as any).kill = (sig?: string) => {
    killSignals.push(sig);
    // A real SIGTERM ends the process; mirror that so a test can tell a
    // deliberate teardown from the budget expiring.
    proc.emit('close', null);
  };
  (proc as any).unref = () => { unrefCount++; };
  const spawnFn = (_cmd: string, _args: string[], _opts: any) => proc;
  return {
    spawnFn,
    proc,
    killSignals,
    get unrefCount() { return unrefCount; },
  };
}

// ── runCbmBootstrap ───────────────────────────────────────────────────────────

describe('runCbmBootstrap', () => {
  it('returns ok:true with durationMs on successful index build', async () => {
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId: 'worker-123',
      serverConfig: fakeCbmConfig(),
      spawnProcess: makeSuccessSpawn() as any,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.cbmCacheDir).toBe('/tmp/cbm-worker-123');
    }
  });

  it('returns ok:false when process exits with non-zero code', async () => {
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId: 'worker-456',
      serverConfig: fakeCbmConfig(),
      spawnProcess: makeFailSpawn(1) as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/code 1/);
      expect(result.cbmCacheDir).toBe('/tmp/cbm-worker-456');
    }
  });

  it('returns ok:false when process emits error event', async () => {
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId: 'worker-789',
      serverConfig: fakeCbmConfig(),
      spawnProcess: makeErrorSpawn('ENOENT: binary not found') as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('ENOENT');
    }
  });

  // ── the wait budget hands the build off, it does not abort it ───────────────
  //
  // Root cause of the index-build failure class: the budget was a client-side
  // KILL. CBM has no server-side request timeout, so every recorded "timeout"
  // was buildd terminating a build that was still making progress — and because
  // 0.10.8 publishes the graph atomically (it indexes into
  // `<project>.db.stage.XXXXXX` and renames at the end, verified against the
  // pinned binary), killing it mid-flight yields no `.db` at all. There is no
  // partial index to salvage; the only thing the kill achieved was throwing the
  // work away. A live MCP server does pick up a `.db` published into its cache
  // dir after it started (verified in-session against 0.10.8), so the build is
  // worth far more running than stopped.

  it('backgrounds the build instead of killing it when the wait budget expires', async () => {
    const hang = makeHangSpawn();
    const workerId = `worker-bg-${process.pid}`;
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: hang.spawnFn as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.backgrounded).toBe(true);
      expect(result.cbmCacheDir).toBe(`/tmp/cbm-${workerId}`);
    }
    // The regression this guards: no signal was sent to the indexer.
    expect(hang.killSignals).toEqual([]);
    // Detached from the runner's event loop so the wait can return.
    expect(hang.unrefCount).toBe(1);
    stopBackgroundCbmIndex(workerId);
    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  it('keeps the cache dir intact when the wait budget expires', async () => {
    const hang = makeHangSpawn();
    const workerId = `worker-bg-keep-${process.pid}`;
    const cacheDir = `/tmp/cbm-${workerId}`;
    mkdirSync(cacheDir, { recursive: true });
    // Stands in for CBM's in-progress staging file: work the backgrounded
    // indexer is still writing into and will rename on completion.
    writeFileSync(`${cacheDir}/project.db.stage.XXXXXX`, 'in progress');

    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: hang.spawnFn as any,
    });

    expect(result.ok).toBe(false);
    expect(existsSync(`${cacheDir}/project.db.stage.XXXXXX`)).toBe(true);
    stopBackgroundCbmIndex(workerId);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('reports a backgrounded build that lands later, so the metric is the real outcome', async () => {
    const hang = makeHangSpawn();
    const workerId = `worker-bg-land-${process.pid}`;
    const late: { ok: boolean; reason?: string }[] = [];
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: hang.spawnFn as any,
      onLateCompletion: r => { late.push(r); },
    });
    expect(result.ok).toBe(false);
    expect(late).toEqual([]);

    // The index finishes after the worker already started its turn.
    hang.proc.emit('close', 0);
    await Promise.resolve();
    expect(late.length).toBe(1);
    expect(late[0]!.ok).toBe(true);

    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  it('reports a backgrounded build that later fails, and does not claim it landed', async () => {
    const hang = makeHangSpawn();
    const workerId = `worker-bg-fail-${process.pid}`;
    const late: { ok: boolean; reason?: string }[] = [];
    await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: hang.spawnFn as any,
      onLateCompletion: r => { late.push(r); },
    });

    hang.proc.emit('close', 3);
    await Promise.resolve();
    expect(late.length).toBe(1);
    expect(late[0]!.ok).toBe(false);
    expect(late[0]!.reason).toMatch(/code 3/);

    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  // Session teardown removes the per-worker cache dir. A backgrounded indexer
  // still writing into it would be writing into a deleted directory and burning
  // a core that the next task's index needs, so teardown must be able to end it —
  // and that deliberate stop must not be logged as a build that failed.
  it('stopBackgroundCbmIndex terminates the indexer without reporting a late failure', async () => {
    const hang = makeHangSpawn();
    const workerId = `worker-bg-stop-${process.pid}`;
    const late: { ok: boolean; reason?: string }[] = [];
    await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: hang.spawnFn as any,
      onLateCompletion: r => { late.push(r); },
    });

    expect(stopBackgroundCbmIndex(workerId)).toBe(true);
    await Promise.resolve();
    expect(hang.killSignals).toEqual(['SIGTERM']);
    expect(late).toEqual([]);
    // Idempotent: teardown runs in a `finally` that can be reached twice.
    expect(stopBackgroundCbmIndex(workerId)).toBe(false);

    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  it('does not register a background indexer when the build finishes inside the budget', async () => {
    const workerId = `worker-bg-none-${process.pid}`;
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      spawnProcess: makeSuccessSpawn() as any,
    });
    expect(result.ok).toBe(true);
    expect(stopBackgroundCbmIndex(workerId)).toBe(false);
    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  it('marks a genuine non-zero exit as a failure, not as backgrounded', async () => {
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId: 'worker-exit-class',
      serverConfig: fakeCbmConfig(),
      spawnProcess: makeFailSpawn(1) as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.backgrounded).toBeFalsy();
  });

  it('passes CBM_CACHE_DIR, CBM_ALLOWED_ROOT, CBM_AUTO_WATCH, CBM_MEM_BUDGET_MB to the subprocess', async () => {
    let capturedEnv: Record<string, string> | undefined;
    const capturingSpawn = (_cmd: string, _args: string[], opts: any) => {
      capturedEnv = opts.env;
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      (proc as any).stdout = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      (proc as any).kill = () => {};
      Promise.resolve().then(() => proc.emit('close', 0));
      return proc;
    };

    await runCbmBootstrap({
      worktreePath: '/tmp/my-worktree',
      workerId: 'wk-env',
      serverConfig: fakeCbmConfig(),
      spawnProcess: capturingSpawn as any,
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!['CBM_CACHE_DIR']).toBe('/tmp/cbm-wk-env');
    expect(capturedEnv!['CBM_ALLOWED_ROOT']).toBe('/tmp/my-worktree');
    expect(capturedEnv!['CBM_AUTO_WATCH']).toBe('false');
    expect(capturedEnv!['CBM_MEM_BUDGET_MB']).toBe('1024');
    // Per-worker daemon runtime dir — without it, a second concurrent worker is
    // refused by the account daemon that already holds a different cache dir.
    expect(capturedEnv!['CBM_RUNTIME_DIR']).toBe('/tmp/cbm-wk-env/run');
  });

  it('substitutes __WORKSPACE_DIR__ in env values from the server config', async () => {
    let capturedEnv: Record<string, string> | undefined;
    const capturingSpawn = (_cmd: string, _args: string[], opts: any) => {
      capturedEnv = opts.env;
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      (proc as any).stdout = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      (proc as any).kill = () => {};
      Promise.resolve().then(() => proc.emit('close', 0));
      return proc;
    };

    await runCbmBootstrap({
      worktreePath: '/home/coder/project/repo',
      workerId: 'wk-sub',
      serverConfig: {
        command: '/opt/buildd/bin/codebase-memory-mcp',
        args: [],
        env: { CBM_ALLOWED_ROOT: '__WORKSPACE_DIR__', CBM_CUSTOM: '__WORKSPACE_DIR__/cache' },
      },
      spawnProcess: capturingSpawn as any,
    });

    expect(capturedEnv!['CBM_ALLOWED_ROOT']).toBe('/home/coder/project/repo');
    expect(capturedEnv!['CBM_CUSTOM']).toBe('/home/coder/project/repo/cache');
  });

  it('spawns with the cli index_repository subcommand and worktree path as args', async () => {
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;
    const capturingSpawn = (cmd: string, args: string[], _opts: any) => {
      capturedCmd = cmd;
      capturedArgs = args;
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      (proc as any).stdout = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      (proc as any).kill = () => {};
      Promise.resolve().then(() => proc.emit('close', 0));
      return proc;
    };

    await runCbmBootstrap({
      worktreePath: '/repo/worktree',
      workerId: 'wk-args',
      serverConfig: fakeCbmConfig(),
      spawnProcess: capturingSpawn as any,
    });

    expect(capturedCmd).toBe('/opt/buildd/bin/codebase-memory-mcp');
    expect(capturedArgs).toEqual(['cli', 'index_repository', '--repo-path', '/repo/worktree']);
  });

  // Regression: the path MUST travel as the value of the --repo-path flag. CBM
  // 0.9.0 parses a bare trailing positional as raw JSON args, so it never
  // populates repo_path — the index worker exits 1 with `repo_path is required`
  // while the server reports the misleading "Indexing worker crashed on a file".
  // The previous assertion encoded the bare-positional form, so it passed for
  // four weeks while every real bootstrap failed.
  it('passes the worktree path as the value of --repo-path, never as a bare positional', async () => {
    let capturedArgs: string[] = [];
    const capturingSpawn = (_cmd: string, args: string[], _opts: any) => {
      capturedArgs = args;
      const { EventEmitter } = require('events');
      const proc = new EventEmitter();
      (proc as any).stdout = new EventEmitter();
      (proc as any).stderr = new EventEmitter();
      (proc as any).kill = () => {};
      Promise.resolve().then(() => proc.emit('close', 0));
      return proc;
    };

    await runCbmBootstrap({
      worktreePath: '/repo/worktree',
      workerId: 'wk-flag',
      serverConfig: fakeCbmConfig(),
      spawnProcess: capturingSpawn as any,
    });

    const flagIndex = capturedArgs.indexOf('--repo-path');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(capturedArgs[flagIndex + 1]).toBe('/repo/worktree');
    // No bare positional after the subcommand.
    expect(capturedArgs[2]).toBe('--repo-path');
  });

  // ── cache-dir cleanup must not disarm CBM for the rest of the session ────────
  //
  // Both failure paths delete the cache dir, and the daemon coordination dir
  // lives inside it. CBM refuses to start at all when CBM_RUNTIME_DIR is missing
  // ("secure daemon endpoint could not be created", verified against 0.10.8), so
  // deleting it turns a warm-cache miss into no CBM at all — the MCP server
  // wired up afterwards would fail to start.

  it('leaves the daemon runtime dir in place after a failed index', async () => {
    const workerId = `worker-rt-fail-${process.pid}`;
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      spawnProcess: makeFailSpawn(1) as any,
    });
    expect(result.ok).toBe(false);
    expect(existsSync(`/tmp/cbm-${workerId}/run`)).toBe(true);
    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  it('leaves the daemon runtime dir in place after the wait budget expires', async () => {
    const workerId = `worker-rt-timeout-${process.pid}`;
    const hang = makeHangSpawn();
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: hang.spawnFn as any,
    });
    expect(result.ok).toBe(false);
    expect(existsSync(`/tmp/cbm-${workerId}/run`)).toBe(true);
    stopBackgroundCbmIndex(workerId);
    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  it('creates the runtime dir before spawning, not world-writable', async () => {
    const workerId = `worker-rt-mode-${process.pid}`;
    await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      spawnProcess: makeSuccessSpawn() as any,
    });
    const mode = statSync(`/tmp/cbm-${workerId}/run`).mode & 0o777;
    // CBM rejects a world-writable coordination dir ("not a usable
    // private-directory parent"); 0755 is accepted, 0777 is not. 0700 is chosen
    // as the tightest mode that satisfies it.
    expect(mode & 0o002).toBe(0);
    rmSync(`/tmp/cbm-${workerId}`, { recursive: true, force: true });
  });

  // ── the budget is a WAIT, and it is tunable without a release ───────────────

  it('keeps the default wait budget at 60s — the fix is what expiry does, not the number', () => {
    // Deliberately unchanged. An uncontended build of a repo this size lands
    // inside it; the builds that overran were the contended ones, and raising
    // the number only moves where a kill would land. Expiry is now a hand-off,
    // so the constant is no longer a cliff and did not need re-tuning.
    expect(CBM_INDEX_WAIT_MS).toBe(60_000);
  });

  it('resolves the wait budget from BUILDD_CBM_INDEX_WAIT_MS when set', () => {
    expect(resolveCbmIndexWaitMs({ BUILDD_CBM_INDEX_WAIT_MS: '15000' })).toBe(15_000);
    expect(resolveCbmIndexWaitMs({})).toBe(CBM_INDEX_WAIT_MS);
  });

  it('ignores a non-numeric or non-positive wait override rather than disabling the wait', () => {
    // A budget of 0 would background EVERY build, which is a fleet-wide
    // behaviour change one typo away. Fail back to the default instead.
    for (const bad of ['', '0', '-1', 'soon', 'NaN']) {
      expect(resolveCbmIndexWaitMs({ BUILDD_CBM_INDEX_WAIT_MS: bad })).toBe(CBM_INDEX_WAIT_MS);
    }
  });
});
