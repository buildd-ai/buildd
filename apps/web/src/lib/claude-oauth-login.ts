/**
 * Claude (Anthropic) OAuth **authorization-code** login — server-side.
 *
 * Lets a buildd user connect Claude from the dashboard by approving in-browser and
 * pasting back a short one-time code — no `~/.claude/.credentials.json` blob, no
 * `claude setup-token` CLI. This is Anthropic's real headless flow (the same one
 * `claude setup-token` drives): the authorize page redirects to
 * `platform.claude.com/oauth/code/callback` and shows a `<code>#<state>` string to
 * copy. Anthropic has no device-code (RFC 8628) endpoint yet
 * (anthropics/claude-code#22992), so this auth-code + paste-the-code flow is the
 * cleanest option.
 *
 * The resulting tokens are stored as a `claude_credential` (access + refresh), which
 * buildd refreshes centrally and injects into workers as an ACCESS-TOKEN-ONLY
 * credential (materializeClaudeConfigDir) — so workers never rotate it.
 *
 * PKCE (S256) is generated here; the verifier round-trips through the client between
 * start and exchange (standard public-client PKCE — single-use, short-lived).
 * Never logs token values.
 */
import { randomBytes, createHash } from 'crypto';
import type { ClaudeCredentialsJson } from './claude-credential';

const CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';

export interface ClaudeOAuthStart {
  authorizeUrl: string;
  /** PKCE verifier — echoed back on exchange. */
  verifier: string;
  /** CSRF state — echoed back on exchange. */
  state: string;
}

/** Step 1 — build the authorize URL + PKCE material. */
export function startClaudeOAuthLogin(): ClaudeOAuthStart {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { authorizeUrl: `${AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

export type ClaudeOAuthExchange =
  | { ok: true; credential: ClaudeCredentialsJson }
  | { ok: false; error: string };

/**
 * Step 2 — exchange the pasted code for tokens. The paste is `<code>#<state>`
 * (Anthropic appends the state as a fragment); we split it and fall back to the
 * `state` passed from start if the paste omits it.
 */
export async function exchangeClaudeOAuthCode(
  pastedCode: string,
  verifier: string,
  state: string,
): Promise<ClaudeOAuthExchange> {
  const trimmed = pastedCode.trim();
  const hashIdx = trimmed.indexOf('#');
  const code = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const stateFromPaste = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';
  if (!code) return { ok: false, error: 'No authorization code provided' };

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        state: stateFromPaste || state,
      }).toString(),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as Record<string, unknown>;
      const msg = (body.error_description ?? body.error ?? (body.error as any)?.message);
      if (typeof msg === 'string') detail += `: ${msg}`;
    } catch { /* ignore */ }
    // A 400 here almost always means the code was mistyped/expired or already used.
    return { ok: false, error: `${detail}. The code is single-use and expires quickly — re-run the connect flow.` };
  }

  const t = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!t.access_token || !t.refresh_token) {
    return { ok: false, error: 'Token response missing access_token/refresh_token' };
  }
  return {
    ok: true,
    credential: {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      ...(typeof t.expires_in === 'number' ? { expires_at: Math.floor(Date.now() / 1000) + t.expires_in } : {}),
    },
  };
}
