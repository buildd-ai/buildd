import { describe, it, expect } from 'bun:test';
import {
  runCbmBootstrap,
  CBM_INDEX_TIMEOUT_MS,
} from '../../src/cbm-bootstrap';
import { existsSync, rmSync, statSync } from 'fs';

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

// Fake spawn that hangs forever (simulates timeout)
function makeHangSpawn() {
  return (_cmd: string, _args: string[], _opts: any) => {
    const { EventEmitter } = require('events');
    const proc = new EventEmitter();
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).kill = () => {
      proc.emit('close', null);
    };
    return proc;
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

  it('returns ok:false with timeout reason when process hangs past deadline', async () => {
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId: 'worker-timeout',
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: makeHangSpawn() as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/timeout after 50ms/);
      expect(result.cbmCacheDir).toBe('/tmp/cbm-worker-timeout');
    }
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

  it('leaves the daemon runtime dir in place after a timeout', async () => {
    const workerId = `worker-rt-timeout-${process.pid}`;
    const result = await runCbmBootstrap({
      worktreePath: '/tmp/worktree',
      workerId,
      serverConfig: fakeCbmConfig(),
      timeoutMs: 50,
      spawnProcess: makeHangSpawn() as any,
    });
    expect(result.ok).toBe(false);
    expect(existsSync(`/tmp/cbm-${workerId}/run`)).toBe(true);
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

  it('exports CBM_INDEX_TIMEOUT_MS as 60000', () => {
    // 0.9.0 indexed this repo in ~10s, but 0.10.x rebuilt the pipeline and adds a
    // daemon cold start: a cold default-mode run measured 32s in the worker image,
    // i.e. over the old 30s budget. A timeout also deletes the cache dir, so the
    // agent starts cold — headroom is cheaper than a wasted index.
    expect(CBM_INDEX_TIMEOUT_MS).toBe(60_000);
  });
});
