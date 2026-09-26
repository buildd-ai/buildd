/**
 * "Connect OpenRouter": OpenRouter's OAuth PKCE flow, which creates a
 * user-controlled API key without copy-paste (openrouter.ai/docs, OAuth PKCE).
 *
 *   1. /api/inference-keys/openrouter/start makes a verifier + S256 challenge,
 *      keeps the verifier in a short-lived httpOnly cookie, and redirects to
 *      https://openrouter.ai/auth?callback_url=…&code_challenge=…
 *   2. OpenRouter redirects to callback_url with ?code= (single use, 10 min).
 *   3. The callback POSTs { code, code_verifier, code_challenge_method } to
 *      https://openrouter.ai/api/v1/auth/keys and gets { key }.
 *   4. The key goes into `secrets` through setProviderKey (team or personal
 *      scope), which checks it with OpenRouter first. It is never logged.
 *
 * The state rides in the callback path, not the query, because OpenRouter
 * appends ?code= to whatever callback_url it was given.
 */
import { createHash, randomBytes } from 'crypto';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
export const PKCE_COOKIE = 'buildd_openrouter_pkce';
export const PKCE_COOKIE_PATH = '/api/inference-keys/openrouter';
/** OpenRouter's code lives ten minutes; the cookie does too. */
export const PKCE_TTL_MS = 10 * 60 * 1000;

export function createPkcePair(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(18).toString('base64url');
  return { verifier, challenge, state };
}

export function buildOpenRouterAuthUrl(o: { callbackUrl: string; challenge: string; keyLabel?: string }): string {
  const u = new URL(OPENROUTER_AUTH_URL);
  u.searchParams.set('callback_url', o.callbackUrl);
  u.searchParams.set('code_challenge', o.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (o.keyLabel) u.searchParams.set('key_label', o.keyLabel);
  return u.toString();
}

export interface PkceFlow {
  state: string;
  verifier: string;
  teamId: string;
  userId: string;
  scope: 'team' | 'user';
  returnTo: string;
  /** Epoch ms. */
  exp: number;
}

export function encodePkceCookie(f: PkceFlow): string {
  return Buffer.from(JSON.stringify(f)).toString('base64url');
}

export function decodePkceCookie(raw: string | undefined | null, now: number = Date.now()): PkceFlow | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PkceFlow>;
    if (typeof f.state !== 'string' || typeof f.verifier !== 'string' || typeof f.teamId !== 'string'
      || typeof f.userId !== 'string' || (f.scope !== 'team' && f.scope !== 'user') || typeof f.exp !== 'number') return null;
    if (f.exp < now) return null;
    return { ...f, returnTo: safeReturnTo(f.returnTo) } as PkceFlow;
  } catch {
    return null;
  }
}

/** Only an in-app page: never another origin, never an API route. */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/app/') || raw.startsWith('//') || raw.includes('\\')) return '/app/home';
  return raw;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function exchangeOpenRouterCode(o: { code: string; verifier: string; fetcher?: Fetcher }): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const fetcher = o.fetcher ?? fetch;
  try {
    const res = await fetcher(OPENROUTER_KEYS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: o.code, code_verifier: o.verifier, code_challenge_method: 'S256' }),
    });
    // The body is never echoed: an error payload is not ours to trust with a key.
    if (!res.ok) return { ok: false, error: `OpenRouter did not accept the sign-in (HTTP ${res.status}).` };
    const body = await res.json().catch(() => ({})) as { key?: unknown };
    if (typeof body.key !== 'string' || !body.key) return { ok: false, error: 'OpenRouter returned no key.' };
    return { ok: true, key: body.key };
  } catch {
    return { ok: false, error: 'Could not reach OpenRouter.' };
  }
}
