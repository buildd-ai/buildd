import { describe, it, expect } from 'bun:test';
import {
  runCbmBootstrap,
  CBM_INDEX_TIMEOUT_MS,
} from '../../src/cbm-bootstrap';

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

  it('exports CBM_INDEX_TIMEOUT_MS as 30000', () => {
    expect(CBM_INDEX_TIMEOUT_MS).toBe(30_000);
  });
});
