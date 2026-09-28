import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  INTERACTIVE_SESSION_HEADER,
  INTERACTIVE_SESSION_TTL_MS,
  UNVERIFIED_INTERACTIVE_RUNNER,
  signInteractiveSession,
  verifyInteractiveSession,
  resolveClaimRunner,
} from './interactive-session';

/**
 * The claim route treats a claim as a person's interactive MCP session only on
 * a marker the MCP routes sign server-side. A client-supplied `runner: 'mcp'`
 * proves nothing: any API key can send it (review of friction 92866723 /
 * cad81659 fixes).
 */
const NOW = 1_790_000_000_000;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { AUTH_SECRET: process.env.AUTH_SECRET, NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY };
  process.env.AUTH_SECRET = 'test-secret';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('interactive session marker', () => {
  it('round-trips the account and session user', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: 'user-1' }, NOW)!;
    expect(verifyInteractiveSession(marker, 'acc-1', NOW)).toEqual({ userId: 'user-1' });
  });

  it('carries no user when the token is not tied to one', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW)!;
    expect(verifyInteractiveSession(marker, 'acc-1', NOW)).toEqual({ userId: null });
  });

  it('is bound to the account that made the MCP call', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: 'user-1' }, NOW)!;
    expect(verifyInteractiveSession(marker, 'acc-2', NOW)).toBeNull();
  });

  it('rejects a tampered user id or signature', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: 'user-1' }, NOW)!;
    const parts = marker.split('.');
    parts[3] = Buffer.from('user-2').toString('base64url');
    expect(verifyInteractiveSession(parts.join('.'), 'acc-1', NOW)).toBeNull();
    expect(verifyInteractiveSession(marker.slice(0, -2) + 'xx', 'acc-1', NOW)).toBeNull();
  });

  it('expires', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW)!;
    expect(verifyInteractiveSession(marker, 'acc-1', NOW + INTERACTIVE_SESSION_TTL_MS + 1)).toBeNull();
    expect(verifyInteractiveSession(marker, 'acc-1', NOW - INTERACTIVE_SESSION_TTL_MS - 1)).toBeNull();
  });

  it('fails closed with no signing secret: nothing signs, nothing verifies', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW)!;
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    expect(signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW)).toBeNull();
    expect(verifyInteractiveSession(marker, 'acc-1', NOW)).toBeNull();
  });

  it('garbage and absent headers verify to null', () => {
    expect(verifyInteractiveSession(null, 'acc-1', NOW)).toBeNull();
    expect(verifyInteractiveSession('mcp', 'acc-1', NOW)).toBeNull();
    expect(verifyInteractiveSession('v1.a.b.c.d', 'acc-1', NOW)).toBeNull();
  });

  it('uses a dedicated header name', () => {
    expect(INTERACTIVE_SESSION_HEADER).toBe('x-buildd-interactive-session');
  });
});

describe('resolveClaimRunner', () => {
  it('keeps runner mcp only with a verified session', () => {
    expect(resolveClaimRunner('mcp', { userId: null })).toBe('mcp');
  });

  it('a client-supplied mcp without the marker is recorded as a runner', () => {
    expect(resolveClaimRunner('mcp', null)).toBe(UNVERIFIED_INTERACTIVE_RUNNER);
    expect(UNVERIFIED_INTERACTIVE_RUNNER).not.toBe('mcp');
  });

  it('leaves every other runner id alone', () => {
    expect(resolveClaimRunner('runner-7', null)).toBe('runner-7');
    expect(resolveClaimRunner('runner-7', { userId: 'u' })).toBe('runner-7');
  });
});
