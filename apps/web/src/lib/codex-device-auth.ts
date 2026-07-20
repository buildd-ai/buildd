/**
 * Codex (ChatGPT) OAuth **device-code** login — server-side.
 *
 * Lets a buildd user connect Codex from the dashboard without pasting an
 * `auth.json`. buildd mints its OWN session (so there's no copied file to go
 * stale) and owns it: the central refresh cron (`refreshCodexCredential`) keeps
 * it alive. This is the fix for the paste-goes-stale failure mode — a shared
 * `auth.json` dies the moment another device rotates the refresh token.
 *
 * Protocol (matches the Codex CLI's `device_code_auth.rs`, client_id
 * `app_EMoamEEZ…`; PKCE is generated server-side by OpenAI and returned on the
 * poll success):
 *   1. POST /api/accounts/deviceauth/usercode {client_id} → {device_auth_id, user_code, interval}
 *   2. poll POST /api/accounts/deviceauth/token {device_auth_id, user_code}
 *        403/404 → still pending; 200 → {authorization_code, code_verifier}
 *   3. POST /oauth/token (form) grant_type=authorization_code + code + code_verifier
 *        + redirect_uri=…/deviceauth/callback → {access_token, refresh_token, id_token, expires_in}
 *
 * Device-code login must be enabled on the account first
 * (ChatGPT → Settings → Security → "Allow device code login") or usercode 404s.
 *
 * Never logs token values.
 */
import type { CodexAuthJson } from './codex-credential';

const CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const BASE_URL = 'https://auth.openai.com';
const API_BASE_URL = `${BASE_URL}/api/accounts`;
/** Page where the user enters the one-time code. */
export const CODEX_DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';

export interface DeviceCodeStart {
  deviceAuthId: string;
  userCode: string;
  /** Seconds the client should wait between polls. */
  interval: number;
  verificationUri: string;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'authorized'; authJson: CodexAuthJson }
  | { status: 'error'; error: string };

/** Step 1 — request a device code. Returns null with a reason on failure. */
export async function startCodexDeviceAuth(): Promise<
  { ok: true; value: DeviceCodeStart } | { ok: false; error: string; deviceLoginDisabled?: boolean }
> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/deviceauth/usercode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }

  if (!res.ok) {
    // 404 == device-code login not enabled for this account.
    if (res.status === 404) {
      return {
        ok: false,
        deviceLoginDisabled: true,
        error: 'Device-code login is not enabled. Turn it on in ChatGPT → Settings → Security → "Allow device code login", then retry.',
      };
    }
    return { ok: false, error: `Device code request failed (HTTP ${res.status})` };
  }

  const data = (await res.json()) as { device_auth_id: string; user_code?: string; usercode?: string; interval: string | number };
  const userCode = data.user_code ?? data.usercode;
  if (!data.device_auth_id || !userCode) {
    return { ok: false, error: 'Malformed device code response' };
  }
  const interval = typeof data.interval === 'string' ? parseInt(data.interval, 10) : data.interval;
  return {
    ok: true,
    value: {
      deviceAuthId: data.device_auth_id,
      userCode,
      interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
    },
  };
}

/**
 * Step 2+3 — poll once. Returns `pending` until the user approves, then exchanges
 * the authorization code for tokens and returns a normalized CodexAuthJson ready
 * for storeCodexCredential. The client should call this every `interval` seconds.
 */
export async function pollCodexDeviceAuth(deviceAuthId: string, userCode: string): Promise<DevicePollResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
  } catch (err) {
    // Transient network error — treat as pending so the client keeps polling.
    return { status: 'pending' };
  }

  // 403/404 while the user hasn't approved yet.
  if (res.status === 403 || res.status === 404) return { status: 'pending' };
  if (!res.ok) return { status: 'error', error: `Polling failed (HTTP ${res.status})` };

  const code = (await res.json()) as { authorization_code?: string; code_verifier?: string };
  if (!code.authorization_code || !code.code_verifier) {
    return { status: 'error', error: 'Malformed authorization response' };
  }

  const tokens = await exchangeCodeForTokens(code.authorization_code, code.code_verifier);
  if (!tokens) return { status: 'error', error: 'Token exchange failed' };

  const accountId = accountIdFromToken(tokens.id_token) ?? accountIdFromToken(tokens.access_token);
  if (!accountId) return { status: 'error', error: 'Could not resolve account id from tokens' };

  return {
    status: 'authorized',
    authJson: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: accountId,
      id_token: tokens.id_token,
      expires_in: tokens.expires_in,
    },
  };
}

async function exchangeCodeForTokens(
  authorizationCode: string,
  codeVerifier: string,
): Promise<{ access_token: string; refresh_token: string; id_token: string; expires_in: number } | null> {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: `${BASE_URL}/deviceauth/callback`,
    }).toString(),
  });
  if (!res.ok) return null;
  return (await res.json()) as { access_token: string; refresh_token: string; id_token: string; expires_in: number };
}

/** Decode the ChatGPT account id from a JWT's auth claim (no signature check). */
function accountIdFromToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, any>;
    return p?.['https://api.openai.com/auth']?.chatgpt_account_id ?? p?.chatgpt_account_id ?? p?.account_id ?? null;
  } catch {
    return null;
  }
}
