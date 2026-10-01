import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mintTaskToken,
  verifyTaskToken,
  isTaskToken,
  resolveTaskTokenTtlMs,
  taskTokenKeyBinding,
  TASK_TOKEN_DEFAULT_TTL_MS,
  TASK_TOKEN_MAX_TTL_MS,
} from './task-token';

const SAVED = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret-a';
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.ENCRYPTION_KEY;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const NOW = 1_800_000_000_000;
const BASE = { accountId: 'acct-1', taskId: 'task-1', workspaceId: 'ws-1', keyHash: 'hash-1' };

describe('task tokens', () => {
  it('round-trips account, task and expiry', () => {
    const minted = mintTaskToken(BASE, NOW)!;
    expect(minted.token.startsWith('bldt_')).toBe(true);
    expect(isTaskToken(minted.token)).toBe(true);
    expect(verifyTaskToken(minted.token, NOW + 1000)).toEqual({
      accountId: 'acct-1',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      keyBinding: taskTokenKeyBinding('hash-1'),
      expiresAt: NOW + TASK_TOKEN_DEFAULT_TTL_MS,
    });
  });

  it('rejects an expired token', () => {
    const minted = mintTaskToken({ ...BASE, ttlMs: 60_000 }, NOW)!;
    expect(verifyTaskToken(minted.token, NOW + 60_000)).toBeNull();
  });

  it('rejects a token whose payload was changed to another task', () => {
    const minted = mintTaskToken(BASE, NOW)!;
    const [, rest] = minted.token.split('bldt_');
    const sig = rest.slice(rest.lastIndexOf('.') + 1);
    const forged = Buffer.from(JSON.stringify({ a: 'acct-1', t: 'task-2', e: NOW + 1e9 })).toString('base64url');
    expect(verifyTaskToken(`bldt_${forged}.${sig}`, NOW)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const minted = mintTaskToken(BASE, NOW)!;
    process.env.AUTH_SECRET = 'test-secret-b';
    expect(verifyTaskToken(minted.token, NOW)).toBeNull();
  });

  it('fails closed with no signing secret', () => {
    delete process.env.AUTH_SECRET;
    expect(mintTaskToken(BASE, NOW)).toBeNull();
  });

  it('rejects garbage and account keys', () => {
    expect(verifyTaskToken('bld_abc', NOW)).toBeNull();
    expect(verifyTaskToken('bldt_', NOW)).toBeNull();
    expect(verifyTaskToken('bldt_not-json.sig', NOW)).toBeNull();
    expect(isTaskToken('bld_abc')).toBe(false);
  });

  it('binds the token to the minting key without carrying the key hash itself', () => {
    const minted = mintTaskToken(BASE, NOW)!;
    expect(minted.token).not.toContain('hash-1');
    const payload = JSON.parse(Buffer.from(minted.token.slice(5, minted.token.lastIndexOf('.')), 'base64url').toString());
    expect(JSON.stringify(payload)).not.toContain('hash-1');
    expect(taskTokenKeyBinding('hash-1')).not.toBe(taskTokenKeyBinding('hash-2'));
  });

  it('caps the lifetime', () => {
    expect(resolveTaskTokenTtlMs(TASK_TOKEN_MAX_TTL_MS * 10)).toBe(TASK_TOKEN_MAX_TTL_MS);
    expect(resolveTaskTokenTtlMs(-1)).toBe(TASK_TOKEN_DEFAULT_TTL_MS);
    expect(resolveTaskTokenTtlMs(undefined)).toBe(TASK_TOKEN_DEFAULT_TTL_MS);
    expect(resolveTaskTokenTtlMs(5_000)).toBe(5_000);
  });
});
