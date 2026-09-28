import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

/**
 * A server-signed marker that says "this request came from buildd's own MCP
 * route, acting for a person's interactive session".
 *
 * `claim_task` sends `runner: 'mcp'`, but that field is client-supplied: any
 * API key can POST it to /api/workers/claim. Everything that treats an
 * interactive worker differently from a runner worker (the reaper's liveness
 * rules, the per-runner claim cooldown) must key off something a client cannot
 * forge. The MCP routes call the REST API over HTTP with the caller's own
 * token, so they add this header, HMAC-signed with a server secret and bound
 * to the calling account, a short validity window, and the session user when
 * the token carries one. A client never sees it and cannot mint it.
 *
 * Fails closed: with no signing secret configured nothing is signed, nothing
 * verifies, and every claim is treated as a runner's.
 */

export const INTERACTIVE_SESSION_HEADER = 'x-buildd-interactive-session';

/** How long a signed marker stays valid (it is minted per MCP request). */
export const INTERACTIVE_SESSION_TTL_MS = 5 * 60 * 1000;

/** `workers.runner` for a claim_task worker from a verified MCP session. */
export const INTERACTIVE_RUNNER = 'mcp';

/**
 * `workers.runner` recorded when a caller sends `runner: 'mcp'` WITHOUT a
 * verified marker. It is a runner id like any other, so runner liveness rules
 * and the per-runner cooldown apply to it.
 */
export const UNVERIFIED_INTERACTIVE_RUNNER = 'mcp-unverified';

export interface InteractiveSession {
  /** The person behind the session when the token is tied to one (OAuth sub). */
  userId: string | null;
  /**
   * The MCP session this call came from (see mintMcpSessionId), when the
   * client echoed one. A bld_ key has no user, so this is what tells two of
   * its sessions apart for liveness.
   */
  sessionKey: string | null;
}

/** HKDF info label: the marker key is dedicated to this use, never the raw secret. */
const KEY_LABEL = 'interactive-session';

let warnedNoSecret = false;

/** Test hook. */
export function resetInteractiveSessionWarning(): void {
  warnedNoSecret = false;
}

/**
 * The marker's HMAC key: HKDF-SHA256 over the existing server secret with the
 * label 'interactive-session', so the marker never signs with a secret other
 * features also use directly. Null (with a one-time warning) when no secret is
 * configured: every claim is then treated as a runner's.
 */
export function interactiveSessionKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY || null;
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn('[interactive-session] no signing secret (AUTH_SECRET / NEXTAUTH_SECRET / ENCRYPTION_KEY): MCP claims cannot be marked interactive and get runner rules.');
    }
    return null;
  }
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32));
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(`interactive-session:${payload}`).digest('base64url');
}

/** `v2.<ts>.<account>.<user>.<session>.<mac>`; null when no secret is configured. */
export function signInteractiveSession(
  input: { accountId: string; userId: string | null | undefined; sessionKey?: string | null },
  now: number = Date.now(),
): string | null {
  const secret = interactiveSessionKey();
  if (!secret) return null;
  const payload = `v2.${now}.${b64(input.accountId)}.${b64(input.userId ?? '')}.${b64(input.sessionKey ?? '')}`;
  return `${payload}.${mac(secret, payload)}`;
}

/** Accepts v2 and the keyless v1 (`v1.<ts>.<account>.<user>.<mac>`). */
export function verifyInteractiveSession(
  header: string | null | undefined,
  accountId: string,
  now: number = Date.now(),
): InteractiveSession | null {
  if (!header) return null;
  const secret = interactiveSessionKey();
  if (!secret) return null;
  const parts = header.split('.');
  const shape = parts[0] === 'v2' ? 6 : parts[0] === 'v1' ? 5 : 0;
  if (!shape || parts.length !== shape) return null;
  const sig = parts[parts.length - 1];
  const expected = Buffer.from(mac(secret, parts.slice(0, -1).join('.')));
  const provided = Buffer.from(sig);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  const [, ts, acc, user, session] = parts;
  const issuedAt = Number(ts);
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > INTERACTIVE_SESSION_TTL_MS) return null;
  if (unb64(acc) !== accountId) return null;
  const userId = unb64(user);
  const sessionKey = shape === 6 ? unb64(session) : '';
  return { userId: userId.length > 0 ? userId : null, sessionKey: sessionKey.length > 0 ? sessionKey : null };
}

// ── MCP session id ───────────────────────────────────────────────────────────

/**
 * The MCP transport is stateless, so nothing identified one client session
 * across its requests. /api/mcp returns one of these as `Mcp-Session-Id` on a
 * request that carries none (a valid one of ours), and Streamable HTTP clients
 * echo it on every later request. Its key rides in the marker above, and the
 * claim and the liveness touch key off it.
 *
 * `s1.<key>.<mac>`, bound to the account. A client can only replay an id it
 * was given for the same account; anything else (another server's id,
 * garbage) is no session, and the route mints a fresh one.
 */
export const MCP_SESSION_ID_HEADER = 'mcp-session-id';

export function mintMcpSessionId(accountId: string): string | null {
  const secret = interactiveSessionKey();
  if (!secret) return null;
  const key = randomBytes(16).toString('base64url');
  return `s1.${key}.${mac(secret, `mcp-session.${accountId}.${key}`)}`;
}

/** The session key of an id minted for this account, or null. */
export function verifyMcpSessionId(header: string | null | undefined, accountId: string): string | null {
  if (!header) return null;
  const parts = header.split('.');
  if (parts.length !== 3 || parts[0] !== 's1' || !parts[1]) return null;
  const secret = interactiveSessionKey();
  if (!secret) return null;
  const expected = Buffer.from(mac(secret, `mcp-session.${accountId}.${parts[1]}`));
  const provided = Buffer.from(parts[2]);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  return parts[1];
}

/** The runner id the claim route records: 'mcp' only for a verified session. */
export function resolveClaimRunner(runner: string, session: InteractiveSession | null): string {
  if (runner === INTERACTIVE_RUNNER && !session) return UNVERIFIED_INTERACTIVE_RUNNER;
  return runner;
}
