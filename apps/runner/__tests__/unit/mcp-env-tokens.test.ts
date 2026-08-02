/**
 * Unit tests for resolveMcpEnvTokens — the runner-side substitution of
 * per-worker placeholder tokens in MCP server env configs.
 */

import { describe, test, expect } from 'bun:test';
import { resolveMcpEnvTokens } from '../../src/mcp-env-tokens';

const CTX = {
  workerId: 'abc-123',
  worktreePath: '/home/coder/project/buildd/.buildd-worktrees/branch-xyz',
};

describe('resolveMcpEnvTokens', () => {
  test('substitutes __WORKER_ID__', () => {
    expect(resolveMcpEnvTokens({ CBM_CACHE_DIR: '/tmp/cbm-__WORKER_ID__' }, CTX)).toEqual({
      CBM_CACHE_DIR: '/tmp/cbm-abc-123',
    });
  });

  test('substitutes __WORKTREE_PATH__', () => {
    expect(resolveMcpEnvTokens({ CBM_ALLOWED_ROOT: '__WORKTREE_PATH__' }, CTX)).toEqual({
      CBM_ALLOWED_ROOT: '/home/coder/project/buildd/.buildd-worktrees/branch-xyz',
    });
  });

  test('substitutes __WORKSPACE_DIR__ (spec alias for __WORKTREE_PATH__)', () => {
    expect(resolveMcpEnvTokens({ CBM_ALLOWED_ROOT: '__WORKSPACE_DIR__' }, CTX)).toEqual({
      CBM_ALLOWED_ROOT: '/home/coder/project/buildd/.buildd-worktrees/branch-xyz',
    });
  });

  test('substitutes multiple tokens in the same value', () => {
    const env = { LOG: '/logs/__WORKER_ID__/__WORKTREE_PATH__/out.log' };
    expect(resolveMcpEnvTokens(env, CTX)).toEqual({
      LOG: `/logs/abc-123/${CTX.worktreePath}/out.log`,
    });
  });

  test('substitutes tokens across multiple env vars', () => {
    const result = resolveMcpEnvTokens(
      { CACHE: '/tmp/__WORKER_ID__', ROOT: '__WORKSPACE_DIR__' },
      CTX,
    );
    expect(result.CACHE).toBe('/tmp/abc-123');
    expect(result.ROOT).toBe(CTX.worktreePath);
  });

  test('leaves env vars without tokens unchanged', () => {
    expect(resolveMcpEnvTokens({ LOG_LEVEL: 'warn', AUTO_WATCH: 'false' }, CTX)).toEqual({
      LOG_LEVEL: 'warn',
      AUTO_WATCH: 'false',
    });
  });

  test('throws a hard error on an unrecognized __TOKEN__', () => {
    expect(() => resolveMcpEnvTokens({ BAD: '/path/__UNKNOWN_TOKEN__' }, CTX)).toThrow(
      'Unresolved MCP env token',
    );
    expect(() => resolveMcpEnvTokens({ BAD: '/path/__UNKNOWN_TOKEN__' }, CTX)).toThrow(
      '__UNKNOWN_TOKEN__',
    );
  });

  test('error message includes the env key name', () => {
    expect(() => resolveMcpEnvTokens({ MY_VAR: '__BAD__' }, CTX)).toThrow('MY_VAR');
  });

  test('returns an empty object for an empty env', () => {
    expect(resolveMcpEnvTokens({}, CTX)).toEqual({});
  });

  test('two concurrent workers get distinct CACHE paths', () => {
    const env = { CACHE: '/tmp/cbm-__WORKER_ID__' };
    const ctx1 = { workerId: 'worker-1', worktreePath: '/worktree/1' };
    const ctx2 = { workerId: 'worker-2', worktreePath: '/worktree/2' };
    const r1 = resolveMcpEnvTokens(env, ctx1);
    const r2 = resolveMcpEnvTokens(env, ctx2);
    expect(r1.CACHE).toBe('/tmp/cbm-worker-1');
    expect(r2.CACHE).toBe('/tmp/cbm-worker-2');
    expect(r1.CACHE).not.toBe(r2.CACHE);
  });

  test('two concurrent workers get distinct worktree roots', () => {
    const env = { ROOT: '__WORKTREE_PATH__' };
    const ctx1 = { workerId: 'worker-1', worktreePath: '/worktree/branch-a' };
    const ctx2 = { workerId: 'worker-2', worktreePath: '/worktree/branch-b' };
    expect(resolveMcpEnvTokens(env, ctx1).ROOT).toBe('/worktree/branch-a');
    expect(resolveMcpEnvTokens(env, ctx2).ROOT).toBe('/worktree/branch-b');
  });

  test('substitutes repeated occurrences of the same token', () => {
    const env = { PATH: '__WORKER_ID__/__WORKER_ID__' };
    expect(resolveMcpEnvTokens(env, CTX)).toEqual({ PATH: 'abc-123/abc-123' });
  });
});
