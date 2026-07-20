import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { startCodexDeviceAuth, pollCodexDeviceAuth } from './codex-device-auth';

// Build a JWT whose payload carries the ChatGPT account id claim.
function jwtWithAccount(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function jsonResponse(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as any;
}

describe('startCodexDeviceAuth', () => {
  it('returns device code details on success', async () => {
    global.fetch = mock(async () => jsonResponse(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '5' })) as any;
    const r = await startCodexDeviceAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceAuthId).toBe('dev-1');
      expect(r.value.userCode).toBe('ABCD-1234');
      expect(r.value.interval).toBe(5);
      expect(r.value.verificationUri).toContain('openai.com');
    }
  });

  it('flags device-login-disabled on 404', async () => {
    global.fetch = mock(async () => jsonResponse(404, {})) as any;
    const r = await startCodexDeviceAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.deviceLoginDisabled).toBe(true);
  });
});

describe('pollCodexDeviceAuth', () => {
  beforeEach(() => { /* fetch set per-test */ });

  it('returns pending while the user has not approved (403)', async () => {
    global.fetch = mock(async () => jsonResponse(403, {})) as any;
    const r = await pollCodexDeviceAuth('dev-1', 'ABCD-1234');
    expect(r.status).toBe('pending');
  });

  it('exchanges the code and returns a normalized authJson on approval', async () => {
    global.fetch = mock(async (url: string) => {
      if (String(url).includes('/deviceauth/token')) {
        return jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' });
      }
      if (String(url).includes('/oauth/token')) {
        return jsonResponse(200, {
          access_token: 'at', refresh_token: 'rt', id_token: jwtWithAccount('acct-xyz'), expires_in: 3600,
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as any;

    const r = await pollCodexDeviceAuth('dev-1', 'ABCD-1234');
    expect(r.status).toBe('authorized');
    if (r.status === 'authorized') {
      expect(r.authJson.access_token).toBe('at');
      expect(r.authJson.refresh_token).toBe('rt');
      expect(r.authJson.account_id).toBe('acct-xyz');
      expect(r.authJson.expires_in).toBe(3600);
    }
  });

  it('errors when the token exchange fails', async () => {
    global.fetch = mock(async (url: string) => {
      if (String(url).includes('/deviceauth/token')) {
        return jsonResponse(200, { authorization_code: 'auth-code', code_verifier: 'verifier' });
      }
      return jsonResponse(400, { error: 'invalid_grant' });
    }) as any;
    const r = await pollCodexDeviceAuth('dev-1', 'ABCD-1234');
    expect(r.status).toBe('error');
  });
});
