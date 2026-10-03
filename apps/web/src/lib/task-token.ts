import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'crypto';
import { TOKEN_PRESETS, type TokenScope } from '@buildd/core/token-scopes';

/**
 * Per-task runner token for a cloud container.
 *
 * A dispatcher that starts one container per task mints one of these with its
 * own runner key (POST /api/runner/task-token) and hands the container this
 * token instead of the key. The token is bound to the minting account, one
 * task and an expiry, and HMAC-signed with a server secret, so a container
 * can neither widen nor extend it.
 *
 * Invariant: a cloud container holds only a token scoped to its own worker.
 * `authenticateApiKey` never accepts a task token, so every route refuses it
 * unless it opts in through `authenticateTaskScopedCaller`
 * (lib/task-token-auth.ts) and checks the scope. Those routes are the task's
 * own claim, a read of its own task, its own worker's read, PATCH, heartbeat,
 * MCP, artifacts, PR, park/re-attach and session-upload calls, and a read of
 * its task's workspace config, and that workspace's memory. The set is pinned by
 * task-token-routes.test.ts.
 *
 * The token also carries the task's workspace (so routes can confine it to
 * that workspace without another lookup) and a binding to the minting key:
 * regenerating or deleting that key ends every token it minted.
 *
 * Fails closed: with no signing secret nothing is minted and nothing verifies.
 */

export const TASK_TOKEN_PREFIX = 'bldt_';

/**
 * What a scoped key must hold to mint task tokens, and keep holding for them
 * to authenticate: the runner preset, which covers every route a task token
 * may call. `admin` holds them all. A legacy (unscoped) key always qualifies.
 * The token is worker-level and confined to one task, so it never does more
 * than the key that minted it.
 */
export const TASK_TOKEN_MINTING_SCOPES: readonly TokenScope[] = TOKEN_PRESETS.runner.scopes;

/** The runner capabilities `scopes` lacks; empty when it may mint (or is a legacy key). */
export function missingTaskTokenScopes(scopes: readonly string[] | null | undefined): TokenScope[] {
  if (scopes == null || scopes.includes('admin')) return [];
  return TASK_TOKEN_MINTING_SCOPES.filter(s => !scopes.includes(s));
}

/** Default and maximum lifetime. Covers a long run plus the input wait of `--once`. */
export const TASK_TOKEN_DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
export const TASK_TOKEN_MAX_TTL_MS = 12 * 60 * 60 * 1000;

export interface TaskTokenClaims {
  /** Account that minted the token; the container acts as this account. */
  accountId: string;
  /** The one task this token may claim and work. */
  taskId: string;
  /** That task's workspace; the only workspace the token may touch. */
  workspaceId: string;
  /** taskTokenKeyBinding(minting key's stored hash); stale once the key is regenerated. */
  keyBinding: string;
  /** Expiry, epoch ms. */
  expiresAt: number;
}

const KEY_LABEL = 'task-token';

function signingKey(): Buffer | null {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.ENCRYPTION_KEY || null;
  if (!secret) return null;
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_LABEL, 32));
}

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(`task-token:${payload}`).digest('base64url');
}

export function isTaskToken(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(TASK_TOKEN_PREFIX);
}

/** Clamp a requested lifetime to (0, max]; anything invalid gets the default. */
export function resolveTaskTokenTtlMs(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n) || n <= 0) return TASK_TOKEN_DEFAULT_TTL_MS;
  return Math.min(n, TASK_TOKEN_MAX_TTL_MS);
}

/**
 * A one-way tag of the minting key's stored hash. The token carries this, not
 * the hash, and authentication compares it to the account's current key.
 */
export function taskTokenKeyBinding(keyHash: string): string {
  return createHash('sha256').update(`task-token-key:${keyHash}`).digest('base64url').slice(0, 22);
}

/** Null when no signing secret is configured. */
export function mintTaskToken(
  input: { accountId: string; taskId: string; workspaceId: string; keyHash: string; ttlMs?: number },
  now: number = Date.now(),
): { token: string; expiresAt: number } | null {
  const key = signingKey();
  if (!key) return null;
  const expiresAt = now + resolveTaskTokenTtlMs(input.ttlMs);
  const payload = Buffer.from(JSON.stringify({
    a: input.accountId,
    t: input.taskId,
    w: input.workspaceId,
    k: taskTokenKeyBinding(input.keyHash),
    e: expiresAt,
  })).toString('base64url');
  return { token: `${TASK_TOKEN_PREFIX}${payload}.${mac(key, payload)}`, expiresAt };
}

/** The claims of a genuine, unexpired task token; null for anything else. */
export function verifyTaskToken(token: string | null | undefined, now: number = Date.now()): TaskTokenClaims | null {
  if (!isTaskToken(token)) return null;
  const key = signingKey();
  if (!key) return null;
  const body = token!.slice(TASK_TOKEN_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = body.slice(0, dot);
  const given = Buffer.from(body.slice(dot + 1));
  const expected = Buffer.from(mac(key, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: { a?: unknown; t?: unknown; w?: unknown; k?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof parsed.a !== 'string' || typeof parsed.t !== 'string' || typeof parsed.w !== 'string'
    || typeof parsed.k !== 'string' || typeof parsed.e !== 'number'
  ) return null;
  if (parsed.e <= now) return null;
  return { accountId: parsed.a, taskId: parsed.t, workspaceId: parsed.w, keyBinding: parsed.k, expiresAt: parsed.e };
}
