import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac, hkdfSync } from 'crypto';
import {
  canMintAdminTaskToken,
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
      level: 'worker',
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

/** Sign an arbitrary payload the way the server does, to test what verify accepts. */
function signed(payload: Record<string, unknown>): string {
  const key = Buffer.from(hkdfSync('sha256', process.env.AUTH_SECRET!, Buffer.alloc(0), 'task-token', 32));
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `bldt_${body}.${createHmac('sha256', key).update(`task-token:${body}`).digest('base64url')}`;
}

describe('task token level', () => {
  const payloadOf = (token: string) => JSON.parse(Buffer.from(token.slice(5, token.lastIndexOf('.')), 'base64url').toString());

  it('a worker token carries no level in its payload, so it is byte-compatible with tokens minted before levels', () => {
    expect(payloadOf(mintTaskToken(BASE, NOW)!.token)).not.toHaveProperty('l');
    expect(payloadOf(mintTaskToken({ ...BASE, level: 'worker' }, NOW)!.token)).not.toHaveProperty('l');
  });

  it('round-trips an admin token', () => {
    const minted = mintTaskToken({ ...BASE, level: 'admin' }, NOW)!;
    expect(verifyTaskToken(minted.token, NOW)?.level).toBe('admin');
  });

  it('reads a token signed without a level as worker', () => {
    const token = signed({ a: 'acct-1', t: 'task-1', w: 'ws-1', k: 'kb', e: NOW + 1000 });
    expect(verifyTaskToken(token, NOW)?.level).toBe('worker');
  });

  it('refuses a signed token with an unknown level instead of reading it as worker', () => {
    const token = signed({ a: 'acct-1', t: 'task-1', w: 'ws-1', k: 'kb', e: NOW + 1000, l: 'owner' });
    expect(verifyTaskToken(token, NOW)).toBeNull();
  });

  it('cannot be raised to admin by editing a worker token', () => {
    const minted = mintTaskToken(BASE, NOW)!;
    const sig = minted.token.slice(minted.token.lastIndexOf('.') + 1);
    const raised = Buffer.from(JSON.stringify({ ...payloadOf(minted.token), l: 'admin' })).toString('base64url');
    expect(verifyTaskToken(`bldt_${raised}.${sig}`, NOW)).toBeNull();
  });
});

describe('canMintAdminTaskToken', () => {
  it('allows a legacy admin key and a scoped key with the full admin scope', () => {
    expect(canMintAdminTaskToken({ level: 'admin', scopes: null })).toBe(true);
    expect(canMintAdminTaskToken({ level: 'admin', scopes: ['admin'] })).toBe(true);
  });

  it('refuses a worker or trigger key and a scoped key with only some admin capabilities', () => {
    expect(canMintAdminTaskToken({ level: 'worker', scopes: null })).toBe(false);
    expect(canMintAdminTaskToken({ level: 'trigger', scopes: null })).toBe(false);
    expect(canMintAdminTaskToken({ level: 'worker', scopes: ['missions:admin', 'tasks:admin', 'workers:admin'] })).toBe(false);
    // The stored level does not stand in for the scope on a scoped key.
    expect(canMintAdminTaskToken({ level: 'admin', scopes: ['tasks:read'] })).toBe(false);
  });
});
