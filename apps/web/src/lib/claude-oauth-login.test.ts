import { describe, it, expect, mock } from 'bun:test';
import { startClaudeOAuthLogin, exchangeClaudeOAuthCode } from './claude-oauth-login';

function jsonResponse(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as any;
}

describe('startClaudeOAuthLogin', () => {
  it('builds an authorize URL with PKCE (S256) + state', () => {
    const s = startClaudeOAuthLogin();
    const u = new URL(s.authorizeUrl);
    expect(u.origin + u.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')).toBe(s.state);
    expect(u.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(s.verifier.length).toBeGreaterThan(20);
    // challenge must be derived from the verifier, not equal to it
    expect(u.searchParams.get('code_challenge')).not.toBe(s.verifier);
  });

  it('generates a fresh verifier each call', () => {
    expect(startClaudeOAuthLogin().verifier).not.toBe(startClaudeOAuthLogin().verifier);
  });
});

describe('exchangeClaudeOAuthCode', () => {
  it('splits code#state, exchanges, and returns a credential', async () => {
    let sentBody = '';
    global.fetch = mock(async (_url: string, init: any) => {
      sentBody = init.body;
      return jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    }) as any;

    const r = await exchangeClaudeOAuthCode('theCode#theState', 'verifier-123', 'fallbackState');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.credential.access_token).toBe('at');
      expect(r.credential.refresh_token).toBe('rt');
      expect(typeof r.credential.expires_at).toBe('number');
    }
    // The code fragment must be stripped and the pasted state preferred.
    expect(sentBody).toContain('code=theCode');
    expect(sentBody).toContain('state=theState');
    expect(sentBody).toContain('code_verifier=verifier-123');
    expect(sentBody).toContain('grant_type=authorization_code');
  });

  it('falls back to the provided state when the paste omits the fragment', async () => {
    let sentBody = '';
    global.fetch = mock(async (_url: string, init: any) => { sentBody = init.body; return jsonResponse(200, { access_token: 'a', refresh_token: 'b' }); }) as any;
    await exchangeClaudeOAuthCode('barecode', 'v', 'startState');
    expect(sentBody).toContain('code=barecode');
    expect(sentBody).toContain('state=startState');
  });

  it('returns an error on a non-2xx exchange (expired/used code)', async () => {
    global.fetch = mock(async () => jsonResponse(400, { error: 'invalid_grant' })) as any;
    const r = await exchangeClaudeOAuthCode('c#s', 'v', 's');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('400');
  });

  it('rejects an empty code', async () => {
    const r = await exchangeClaudeOAuthCode('   ', 'v', 's');
    expect(r.ok).toBe(false);
  });
});
