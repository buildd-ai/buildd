import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createHmac, hkdfSync } from 'crypto';
import {
  INTERACTIVE_SESSION_HEADER,
  INTERACTIVE_SESSION_TTL_MS,
  UNVERIFIED_INTERACTIVE_RUNNER,
  signInteractiveSession,
  verifyInteractiveSession,
  resolveClaimRunner,
  interactiveSessionKey,
  resetInteractiveSessionWarning,
  mintMcpSessionId,
  verifyMcpSessionId,
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
    expect(verifyInteractiveSession(marker, 'acc-1', NOW)).toEqual({ userId: 'user-1', sessionKey: null });
  });

  it('carries no user when the token is not tied to one', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW)!;
    expect(verifyInteractiveSession(marker, 'acc-1', NOW)).toEqual({ userId: null, sessionKey: null });
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

// A bld_ key has no session user, so two sessions on one key were one
// identity to the liveness touch. The MCP session id (minted by /api/mcp,
// echoed by the client) rides in the marker and tells them apart.
describe('interactive session marker: the MCP session key', () => {
  it('round-trips the session key', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: null, sessionKey: 'sess-a' }, NOW)!;
    expect(verifyInteractiveSession(marker, 'acc-1', NOW)).toEqual({ userId: null, sessionKey: 'sess-a' });
  });

  it('a tampered session key does not verify', () => {
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: null, sessionKey: 'sess-a' }, NOW)!;
    const parts = marker.split('.');
    parts[4] = Buffer.from('sess-b').toString('base64url');
    expect(verifyInteractiveSession(parts.join('.'), 'acc-1', NOW)).toBeNull();
  });

  it('a v1 marker (no session field) still verifies, as keyless', () => {
    const key = interactiveSessionKey()!;
    const payload = `v1.${NOW}.${Buffer.from('acc-1').toString('base64url')}.`;
    const mac = createHmac('sha256', key).update(`interactive-session:${payload}`).digest('base64url');
    expect(verifyInteractiveSession(`${payload}.${mac}`, 'acc-1', NOW)).toEqual({ userId: null, sessionKey: null });
  });
});

describe('MCP session id', () => {
  it('is minted fresh per call and verifies to its key for the account that minted it', () => {
    const a = mintMcpSessionId('acc-1')!;
    const b = mintMcpSessionId('acc-1')!;
    expect(a).not.toBe(b);
    const key = verifyMcpSessionId(a, 'acc-1');
    expect(key).toBeTruthy();
    expect(key).not.toBe(verifyMcpSessionId(b, 'acc-1'));
  });

  it("another account's id, a forged one, or garbage is no session", () => {
    const a = mintMcpSessionId('acc-1')!;
    expect(verifyMcpSessionId(a, 'acc-2')).toBeNull();
    expect(verifyMcpSessionId(a.slice(0, -2) + 'xx', 'acc-1')).toBeNull();
    expect(verifyMcpSessionId('some-other-server-session', 'acc-1')).toBeNull();
    expect(verifyMcpSessionId(null, 'acc-1')).toBeNull();
  });

  it('fails closed with no signing secret', () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    expect(mintMcpSessionId('acc-1')).toBeNull();
  });
});

describe('resolveClaimRunner', () => {
  it('keeps runner mcp only with a verified session', () => {
    expect(resolveClaimRunner('mcp', { userId: null, sessionKey: null })).toBe('mcp');
  });

  it('a client-supplied mcp without the marker is recorded as a runner', () => {
    expect(resolveClaimRunner('mcp', null)).toBe(UNVERIFIED_INTERACTIVE_RUNNER);
    expect(UNVERIFIED_INTERACTIVE_RUNNER).not.toBe('mcp');
  });

  it('leaves every other runner id alone', () => {
    expect(resolveClaimRunner('runner-7', null)).toBe('runner-7');
    expect(resolveClaimRunner('runner-7', { userId: 'u', sessionKey: null })).toBe('runner-7');
  });
});

describe('marker key', () => {
  it('is derived from the configured secret with HKDF (label interactive-session), not the raw secret', () => {
    const expected = Buffer.from(hkdfSync('sha256', 'test-secret', Buffer.alloc(0), 'interactive-session', 32));
    expect(interactiveSessionKey()!.equals(expected)).toBe(true);
    const marker = signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW)!;
    const payload = marker.split('.').slice(0, -1).join('.');
    const rawMac = createHmac('sha256', 'test-secret').update(`interactive-session:${payload}`).digest('base64url');
    expect(marker.endsWith(rawMac)).toBe(false);
  });

  it('warns once when no signing secret resolves', () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    resetInteractiveSessionWarning();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW);
      signInteractiveSession({ accountId: 'acc-1', userId: null }, NOW);
      verifyInteractiveSession('v1.1.a.b.c', 'acc-1', NOW);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/interactive-session/);
    } finally {
      warn.mockRestore();
    }
  });
});
