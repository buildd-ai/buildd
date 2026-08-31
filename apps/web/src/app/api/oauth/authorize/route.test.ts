import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// Registered redirect URIs for the single fake client row; each test sets this.
let registeredUris: string[] = [];

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
  insert: () => ({ values: async () => undefined }),
  query: {
    teamMembers: { findMany: async () => [{ teamId: 'team-1' }] },
    workspaces: {
      findMany: async () => [{ id: 'ws-1', name: 'Acme Workspace', teamId: 'team-1' }],
    },
  },
};

mock.module('@buildd/core/db', () => ({ db: fakeDb }));
mock.module('@/auth', () => ({ auth: async () => ({ user: { id: 'user-1' } }) }));

import { GET, isRegisteredRedirectUri } from './route';

function authorizeRequest(redirectUri: string) {
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: 'c_test',
    redirect_uri: redirectUri,
    code_challenge: 'fake-challenge',
    code_challenge_method: 'S256',
    state: 'fake-state',
    workspace: 'ws-1',
  }).toString();
  return new NextRequest(`https://buildd.dev/api/oauth/authorize?${qs}`);
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

// ---------------------------------------------------------------------------
// The authorized interstitial must never put the resolved callback URL into a
// script context: JSON.stringify does not neutralise a script-closing
// sequence, and the WHATWG URL parser preserves raw angle brackets in the
// opaque path of a non-special scheme.
// ---------------------------------------------------------------------------

describe('GET /api/oauth/authorize — authorized interstitial', () => {
  beforeEach(() => {
    registeredUris = [];
  });

  it('does not emit a registered script-closing sequence unescaped', async () => {
    const hostileUri = 'com.example.app:cb</script>';
    registeredUris = [hostileUri];

    const res = await GET(authorizeRequest(hostileUri));
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

    const res = await GET(authorizeRequest('https://client.example.com/callback'));
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
