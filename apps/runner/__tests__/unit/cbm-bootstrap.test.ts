import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import {
  detectCbmConfig,
  runCbmBootstrap,
  buildCbmMcpEntry,
  CBM_INDEX_TIMEOUT_MS,
} from '../../src/cbm-bootstrap';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a readFileFn seam that returns the given JSON content for any path,
 * or throws ENOENT when null is passed.
 */
function makeReadFileFn(content: unknown | null) {
  return (_path: string, _encoding: 'utf-8'): string => {
    if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return JSON.stringify(content);
  };
}

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
    let killed = false;
    (proc as any).kill = () => {
      killed = true;
      proc.emit('close', null);
    };
    return proc;
  };
}

// ── detectCbmConfig ───────────────────────────────────────────────────────────

describe('detectCbmConfig', () => {
  it('returns null when readFileFn throws (file not found)', () => {
    expect(detectCbmConfig('/any/path/.mcp.json', makeReadFileFn(null))).toBeNull();
  });

  it('returns null when .mcp.json has no mcpServers', () => {
    expect(detectCbmConfig('/p/.mcp.json', makeReadFileFn({ other: 'stuff' }))).toBeNull();
  });

  it('returns null when codebase-memory is missing from mcpServers', () => {
    expect(detectCbmConfig('/p/.mcp.json', makeReadFileFn({
      mcpServers: { buildd: { type: 'http', url: 'http://buildd' } },
    }))).toBeNull();
  });

  it('returns null when codebase-memory has type http (not stdio)', () => {
    expect(detectCbmConfig('/p/.mcp.json', makeReadFileFn({
      mcpServers: { 'codebase-memory': { type: 'http', url: 'http://cbm' } },
    }))).toBeNull();
  });

  it('returns null when codebase-memory has no command', () => {
    expect(detectCbmConfig('/p/.mcp.json', makeReadFileFn({
      mcpServers: { 'codebase-memory': { type: 'stdio', args: ['mcp'] } },
    }))).toBeNull();
  });

  it('returns config when codebase-memory is a valid stdio server', () => {
    const result = detectCbmConfig('/p/.mcp.json', makeReadFileFn({
      mcpServers: {
        buildd: { type: 'http', url: 'http://buildd' },
        'codebase-memory': {
          type: 'stdio',
          command: '/opt/buildd/bin/codebase-memory-mcp',
          args: ['mcp'],
          env: { CBM_AUTO_WATCH: 'false' },
        },
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.command).toBe('/opt/buildd/bin/codebase-memory-mcp');
    expect(result!.args).toEqual(['mcp']);
    expect(result!.env.CBM_AUTO_WATCH).toBe('false');
  });

  it('returns config with empty args and env when omitted', () => {
    const result = detectCbmConfig('/p/.mcp.json', makeReadFileFn({
      mcpServers: {
        'codebase-memory': {
          type: 'stdio',
          command: '/opt/buildd/bin/codebase-memory-mcp',
        },
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.args).toEqual([]);
    expect(result!.env).toEqual({});
  });

  it('returns null when JSON is invalid (readFileFn returns bad content)', () => {
    const badReadFn = (_path: string, _enc: 'utf-8') => 'not valid json {{{';
    expect(detectCbmConfig('/p/.mcp.json', badReadFn)).toBeNull();
  });
});

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
    expect(capturedArgs).toEqual(['cli', 'index_repository', '/repo/worktree']);
  });

  it('exports CBM_INDEX_TIMEOUT_MS as 30000', () => {
    expect(CBM_INDEX_TIMEOUT_MS).toBe(30_000);
  });
});

// ── buildCbmMcpEntry ──────────────────────────────────────────────────────────

describe('buildCbmMcpEntry', () => {
  it('returns a stdio MCP server entry with type:stdio', () => {
    const entry = buildCbmMcpEntry(fakeCbmConfig(), '/tmp/cbm-worker-1', '/repo/cwd');
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe('/opt/buildd/bin/codebase-memory-mcp');
  });

  it('sets CBM_CACHE_DIR to the provided cbmCacheDir', () => {
    const entry = buildCbmMcpEntry(fakeCbmConfig(), '/tmp/cbm-my-worker', '/repo/cwd');
    expect(entry.env['CBM_CACHE_DIR']).toBe('/tmp/cbm-my-worker');
  });

  it('sets CBM_ALLOWED_ROOT to the worktree path', () => {
    const entry = buildCbmMcpEntry(fakeCbmConfig(), '/tmp/cbm-x', '/my/worktree');
    expect(entry.env['CBM_ALLOWED_ROOT']).toBe('/my/worktree');
  });

  it('substitutes __WORKSPACE_DIR__ in base env values', () => {
    const config = {
      command: '/bin/cbm',
      args: [],
      env: { CBM_ALLOWED_ROOT: '__WORKSPACE_DIR__', EXTRA: '__WORKSPACE_DIR__/sub' },
    };
    const entry = buildCbmMcpEntry(config, '/tmp/cbm-w', '/actual/cwd');
    expect(entry.env['CBM_ALLOWED_ROOT']).toBe('/actual/cwd');
    expect(entry.env['EXTRA']).toBe('/actual/cwd/sub');
  });

  it('always sets CBM_AUTO_WATCH=false and CBM_MEM_BUDGET_MB=1024', () => {
    const entry = buildCbmMcpEntry(fakeCbmConfig(), '/tmp/cbm-y', '/cwd');
    expect(entry.env['CBM_AUTO_WATCH']).toBe('false');
    expect(entry.env['CBM_MEM_BUDGET_MB']).toBe('1024');
  });

  it('passes through server args from config', () => {
    const config = { ...fakeCbmConfig(), args: ['mcp', '--extra'] };
    const entry = buildCbmMcpEntry(config, '/tmp/cbm-z', '/cwd');
    expect(entry.args).toEqual(['mcp', '--extra']);
  });
});
