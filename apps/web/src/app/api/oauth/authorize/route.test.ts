import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Registered redirect URIs for the single fake client row; each test sets this.
let registeredUris: string[] = [];
let authCodeInserts = 0;
let memberRole: string | undefined = 'admin';

process.env.OAUTH_JWT_SECRET = process.env.OAUTH_JWT_SECRET || 'test-oauth-secret';

const fakeDb = {
  // storage.getClient(): db.select().from().where().limit(1)
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [
          { clientId: 'c_test', clientName: 'Test Connector', redirectUris: registeredUris },
        ],
      }),
    }),
  }),
  // storage.createAuthCode(): db.insert().values()
  insert: () => ({ values: async () => { authCodeInserts++; } }),
  query: {
    teamMembers: { findMany: async () => [{ teamId: 'team-1', role: memberRole }] },
    workspaces: {
      findMany: async () => [{ id: 'ws-1', name: 'Acme Workspace', teamId: 'team-1' }],
    },
  },
};

mock.module('@buildd/core/db', () => ({ db: fakeDb }));
mock.module('@/auth', () => ({ auth: async () => ({ user: { id: 'user-1' } }) }));

import { GET, POST, isRegisteredRedirectUri } from './route';

function authorizeParams(redirectUri: string) {
  return {
    response_type: 'code',
    client_id: 'c_test',
    redirect_uri: redirectUri,
    code_challenge: 'fake-challenge',
    code_challenge_method: 'S256',
    state: 'fake-state',
    workspace: 'ws-1',
  };
}

function authorizeRequest(redirectUri: string) {
  const qs = new URLSearchParams(authorizeParams(redirectUri)).toString();
  return new NextRequest(`https://buildd.dev/api/oauth/authorize?${qs}`);
}

/** Hidden inputs of the consent form, as the browser would submit them. */
function consentFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[m[1]] = m[2]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  return fields;
}

function consentPost(fields: Record<string, string>, origin: string | null = 'https://buildd.dev') {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (origin) headers.origin = origin;
  return new NextRequest('https://buildd.dev/api/oauth/authorize', {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

/** GET the consent page and approve it — the path a real browser takes. */
async function approve(redirectUri: string) {
  const page = await GET(authorizeRequest(redirectUri));
  const fields = consentFields(await page.text());
  return POST(consentPost({ ...fields, decision: 'approve' }));
}

/** Bodies of every inline <script> block in the document. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

describe('OAuth authorize redirect URI validation', () => {
  it('accepts equivalent loopback hostnames for the same callback URI', () => {
    expect(
      isRegisteredRedirectUri(
        ['http://localhost:41776/callback/ziW6hvS99iVJ'],
        'http://127.0.0.1:41776/callback/ziW6hvS99iVJ',
      ),
    ).toBe(true);
  });

  it('rejects loopback callbacks with a different port or path', () => {
    expect(
      isRegisteredRedirectUri(
        ['http://localhost:41776/callback/ziW6hvS99iVJ'],
        'http://127.0.0.1:14567/callback/ziW6hvS99iVJ',
      ),
    ).toBe(false);
    expect(
      isRegisteredRedirectUri(
        ['http://localhost:41776/callback/ziW6hvS99iVJ'],
        'http://127.0.0.1:41776/callback/other',
      ),
    ).toBe(false);
  });

  it('keeps exact matching for non-loopback redirect URIs', () => {
    expect(
      isRegisteredRedirectUri(
        ['https://example.com/callback'],
        'https://example.com/callback',
      ),
    ).toBe(true);
    expect(
      isRegisteredRedirectUri(
        ['https://example.com/callback'],
        'https://example.org/callback',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redirect-scheme validation (registered rows that predate validation must not
// become usable at authorize time).
// ---------------------------------------------------------------------------

describe('OAuth authorize redirect URI scheme validation', () => {
  it('rejects dangerous schemes even when they are the registered value', () => {
    for (const uri of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'vbscript:msgbox(1)',
      'file:///etc/hosts',
      'blob:https://example.com/abc',
    ]) {
      expect(isRegisteredRedirectUri([uri], uri)).toBe(false);
    }
  });

  it('rejects a redirect URI carrying a fragment', () => {
    expect(
      isRegisteredRedirectUri(['https://example.com/cb#frag'], 'https://example.com/cb#frag'),
    ).toBe(false);
  });

  it('still accepts https, loopback and private-use schemes', () => {
    expect(isRegisteredRedirectUri(['https://example.com/cb'], 'https://example.com/cb')).toBe(true);
    expect(
      isRegisteredRedirectUri(['http://localhost:41776/cb'], 'http://127.0.0.1:41776/cb'),
    ).toBe(true);
    expect(
      isRegisteredRedirectUri(['com.example.app://cb'], 'com.example.app://cb'),
    ).toBe(true);
  });
});

describe('GET /api/oauth/authorize — consent page', () => {
  beforeEach(() => {
    registeredUris = ['https://client.example.com/callback'];
    authCodeInserts = 0;
    memberRole = 'admin';
  });

  it('renders an approve form and issues no code on GET', async () => {
    const res = await GET(authorizeRequest('https://client.example.com/callback'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(authCodeInserts).toBe(0);
    expect(html).not.toContain('code=');
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain('method="post"');
    expect(html).toContain('Test Connector');
    expect(html).toContain('Acme Workspace');
    expect(consentFields(html).csrf_token).toBeTruthy();
  });

  it('states the access the connection will have, from the team role', async () => {
    memberRole = 'member';
    const html = await (await GET(authorizeRequest('https://client.example.com/callback'))).text();
    expect(html).toContain('data-access-level="worker"');

    memberRole = 'owner';
    const ownerHtml = await (await GET(authorizeRequest('https://client.example.com/callback'))).text();
    expect(ownerHtml).toContain('data-access-level="admin"');
  });

  it('cannot be framed', async () => {
    const res = await GET(authorizeRequest('https://client.example.com/callback'));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('POST /api/oauth/authorize — consent decision', () => {
  beforeEach(() => {
    registeredUris = ['https://client.example.com/callback'];
    authCodeInserts = 0;
    memberRole = 'admin';
  });

  it('approve with a valid token from the same origin issues exactly one code', async () => {
    const res = await approve('https://client.example.com/callback');
    expect(res.status).toBe(200);
    expect(authCodeInserts).toBe(1);
    const html = await res.text();
    expect(html).toContain('<a href="https://client.example.com/callback?code=');
    expect(html).toContain('state=fake-state');
  });

  it('refuses a POST without the consent token', async () => {
    const res = await POST(consentPost({ ...authorizeParams('https://client.example.com/callback'), decision: 'approve' }));
    expect(res.status).toBe(403);
    expect(authCodeInserts).toBe(0);
  });

  it('refuses a consent token issued for different parameters', async () => {
    const page = await GET(authorizeRequest('https://client.example.com/callback'));
    const fields = consentFields(await page.text());
    const res = await POST(consentPost({ ...fields, code_challenge: 'other-challenge', decision: 'approve' }));
    expect(res.status).toBe(403);
    expect(authCodeInserts).toBe(0);
  });

  it('refuses a cross-origin POST even with a valid token', async () => {
    const page = await GET(authorizeRequest('https://client.example.com/callback'));
    const fields = consentFields(await page.text());
    const res = await POST(consentPost({ ...fields, decision: 'approve' }, 'https://elsewhere.example'));
    expect(res.status).toBe(403);
    expect(authCodeInserts).toBe(0);
  });

  it('refuses a POST with no Origin header', async () => {
    const page = await GET(authorizeRequest('https://client.example.com/callback'));
    const fields = consentFields(await page.text());
    const res = await POST(consentPost({ ...fields, decision: 'approve' }, null));
    expect(res.status).toBe(403);
    expect(authCodeInserts).toBe(0);
  });

  it('deny redirects back with access_denied and issues no code', async () => {
    const page = await GET(authorizeRequest('https://client.example.com/callback'));
    const fields = consentFields(await page.text());
    const res = await POST(consentPost({ ...fields, decision: 'deny' }));
    expect(authCodeInserts).toBe(0);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('https://client.example.com/callback');
    expect(location).toContain('error=access_denied');
    expect(location).toContain('state=fake-state');
  });
});

// ---------------------------------------------------------------------------
// The authorized interstitial (after approval) must never put the resolved
// callback URL into a script context: JSON.stringify does not neutralise a
// script-closing sequence, and the WHATWG URL parser preserves raw angle
// brackets in the opaque path of a non-special scheme.
// ---------------------------------------------------------------------------

describe('POST /api/oauth/authorize — authorized interstitial', () => {
  beforeEach(() => {
    registeredUris = [];
    memberRole = 'admin';
  });

  it('does not emit a registered script-closing sequence unescaped', async () => {
    const hostileUri = 'com.example.app:cb</script>';
    registeredUris = [hostileUri];

    const consent = await GET(authorizeRequest(hostileUri));
    expect(consent.status).toBe(200);
    expect(await consent.text()).not.toContain('cb</script>');

    const res = await approve(hostileUri);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain('cb</script>');
    expect(html).toContain('cb&lt;/script&gt;');
    for (const body of inlineScripts(html)) {
      expect(body).not.toContain('cb');
    }
  });

  it('still renders and navigates for a normal https redirect', async () => {
    registeredUris = ['https://client.example.com/callback'];

    const res = await approve('https://client.example.com/callback');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();

    // Non-script navigation paths both present and pointed at the callback.
    expect(html).toMatch(/<meta http-equiv="refresh" content="\d+;url=https:\/\/client\.example\.com\/callback\?code=[^"]*"/);
    expect(html).toContain('<a href="https://client.example.com/callback?code=');
    expect(html).toContain('Acme Workspace');
    // No inline script may carry the callback URL.
    for (const body of inlineScripts(html)) {
      expect(body).not.toContain('client.example.com');
    }
  });

  it('rejects a stored client whose redirect URI uses a dangerous scheme', async () => {
    registeredUris = ['javascript:alert(1)'];

    const res = await GET(authorizeRequest('javascript:alert(1)'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('not registered');
  });
});

afterAll(() => mock.restore());
