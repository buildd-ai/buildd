import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

process.env.OAUTH_JWT_SECRET = 'test-secret-do-not-use-in-prod-32-chars-min';
process.env.OAUTH_ISSUER = 'https://buildd.test';

import {
  parseBearerChallenge,
  discoverOAuthMetadata,
  registerClient,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  validateTokenAudience,
  generateCodeVerifier,
  deriveCodeChallenge,
  signOAuthState,
  verifyOAuthState,
  getCallbackUrl,
  type ASMetadata,
} from './mcp-oauth';

// ─── parseBearerChallenge ─────────────────────────────────────────────────────

describe('parseBearerChallenge', () => {
  it('parses resource_metadata from Bearer challenge', () => {
    const header = 'Bearer realm="example", resource_metadata="https://auth.example.com/.well-known/prf"';
    const result = parseBearerChallenge(header);
    expect(result['resource_metadata']).toBe('https://auth.example.com/.well-known/prf');
    expect(result['realm']).toBe('example');
  });

  it('returns empty object for non-Bearer header', () => {
    expect(parseBearerChallenge('Basic realm="test"')).toEqual({});
    expect(parseBearerChallenge('')).toEqual({});
  });

  it('handles Bearer with no params', () => {
    expect(parseBearerChallenge('Bearer ')).toEqual({});
  });
});

// ─── discoverOAuthMetadata ────────────────────────────────────────────────────

describe('discoverOAuthMetadata', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('returns authMode=none when connector responds 200', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );

    const result = await discoverOAuthMetadata('https://mcp.example.com');
    expect(result).toEqual({ authMode: 'none' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on unexpected non-401 error', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Not Found', { status: 404 }),
    );

    await expect(discoverOAuthMetadata('https://mcp.example.com')).rejects.toThrow(
      'unexpected status 404',
    );
  });

  it('runs full discovery flow on 401 with resource_metadata', async () => {
    const protectedResourceMetadata = {
      resource: 'https://mcp.example.com',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['mcp:read'],
    };

    const asMetadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      registration_endpoint: 'https://auth.example.com/register',
      code_challenge_methods_supported: ['S256'],
    };

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('Unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer realm="mcp", resource_metadata="https://auth.example.com/.well-known/prf"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(protectedResourceMetadata), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(asMetadata), { status: 200 }),
      );

    const result = await discoverOAuthMetadata('https://mcp.example.com');

    expect(result.authMode).toBe('oauth');
    if (result.authMode === 'oauth') {
      expect(result.protectedResource.resource).toBe('https://mcp.example.com');
      expect(result.authorizationServer.token_endpoint).toBe('https://auth.example.com/token');
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Second call should fetch the resource_metadata URL
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe(
      'https://auth.example.com/.well-known/prf',
    );
  });

  it('falls back to /.well-known/oauth-protected-resource when no resource_metadata in header', async () => {
    const protectedResource = {
      resource: 'https://mcp.example.com',
      authorization_servers: ['https://mcp.example.com'],
    };
    const asMetadata = {
      issuer: 'https://mcp.example.com',
      authorization_endpoint: 'https://mcp.example.com/authorize',
      token_endpoint: 'https://mcp.example.com/token',
    };

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('Unauthorized', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="mcp"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(protectedResource), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(asMetadata), { status: 200 }),
      );

    await discoverOAuthMetadata('https://mcp.example.com');

    // Should request the fallback well-known URL
    expect((fetchSpy.mock.calls[1] as [string])[0]).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource',
    );
  });

  it('falls back to openid-configuration when oauth-authorization-server 404s', async () => {
    const protectedResource = {
      resource: 'https://mcp.example.com',
      authorization_servers: ['https://auth.example.com'],
    };
    const asMetadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    };

    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('Unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Bearer resource_metadata="https://auth.example.com/.well-known/prf"',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(protectedResource), { status: 200 }),
      )
      // Primary AS metadata fails
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      // Fallback OIDC config succeeds
      .mockResolvedValueOnce(new Response(JSON.stringify(asMetadata), { status: 200 }));

    const result = await discoverOAuthMetadata('https://mcp.example.com');
    expect(result.authMode).toBe('oauth');
    if (result.authMode === 'oauth') {
      expect(result.authorizationServer.issuer).toBe('https://auth.example.com');
    }
    // 4 calls: probe + protected resource + AS primary (404) + AS fallback
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('falls back to POST when GET returns 405, reading WWW-Authenticate from the POST 401', async () => {
    // Streamable-HTTP MCP servers (e.g. cue.buildd.dev) answer 405 to GET but
    // emit the 401 + WWW-Authenticate challenge on POST.
    const protectedResource = {
      resource: 'https://cue.buildd.dev/api/mcp',
      authorization_servers: ['https://cue.buildd.dev'],
    };
    const asMetadata = {
      issuer: 'https://cue.buildd.dev',
      authorization_endpoint: 'https://cue.buildd.dev/authorize',
      token_endpoint: 'https://cue.buildd.dev/token',
    };

    fetchSpy = spyOn(globalThis, 'fetch')
      // GET → 405 (POST-only server rejects GET)
      .mockResolvedValueOnce(new Response('Method Not Allowed', { status: 405 }))
      // POST → 401 with the RFC 9728 challenge
      .mockResolvedValueOnce(
        new Response('Unauthorized', {
          status: 401,
          headers: {
            'WWW-Authenticate':
              'Bearer resource_metadata="https://cue.buildd.dev/.well-known/oauth-protected-resource"',
          },
        }),
      )
      // Protected Resource Metadata
      .mockResolvedValueOnce(
        new Response(JSON.stringify(protectedResource), { status: 200 }),
      )
      // AS metadata
      .mockResolvedValueOnce(new Response(JSON.stringify(asMetadata), { status: 200 }));

    const result = await discoverOAuthMetadata('https://cue.buildd.dev/api/mcp');

    expect(result.authMode).toBe('oauth');
    if (result.authMode === 'oauth') {
      expect(result.protectedResource.resource).toBe('https://cue.buildd.dev/api/mcp');
      expect(result.authorizationServer.token_endpoint).toBe('https://cue.buildd.dev/token');
    }

    // Call 1 is the GET probe, call 2 must be the POST fallback to the connector URL.
    const [postUrl, postInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(postUrl).toBe('https://cue.buildd.dev/api/mcp');
    expect(postInit.method).toBe('POST');
    // Call 3 fetches the resource_metadata URL from the POST challenge.
    expect((fetchSpy.mock.calls[2] as [string])[0]).toBe(
      'https://cue.buildd.dev/.well-known/oauth-protected-resource',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('falls back to origin well-known PR metadata when GET is 405 and POST yields no challenge', async () => {
    const protectedResource = {
      resource: 'https://cue.buildd.dev/api/mcp',
      authorization_servers: ['https://cue.buildd.dev'],
    };
    const asMetadata = {
      issuer: 'https://cue.buildd.dev',
      authorization_endpoint: 'https://cue.buildd.dev/authorize',
      token_endpoint: 'https://cue.buildd.dev/token',
    };

    fetchSpy = spyOn(globalThis, 'fetch')
      // GET → 405
      .mockResolvedValueOnce(new Response('Method Not Allowed', { status: 405 }))
      // POST → 401 but WITHOUT a WWW-Authenticate header (no usable challenge)
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))
      // Origin-derived well-known PR metadata → 200
      .mockResolvedValueOnce(
        new Response(JSON.stringify(protectedResource), { status: 200 }),
      )
      // AS metadata
      .mockResolvedValueOnce(new Response(JSON.stringify(asMetadata), { status: 200 }));

    const result = await discoverOAuthMetadata('https://cue.buildd.dev/api/mcp');

    expect(result.authMode).toBe('oauth');
    if (result.authMode === 'oauth') {
      expect(result.authorizationServer.issuer).toBe('https://cue.buildd.dev');
    }
    // Third call is the origin-derived well-known PR metadata URL.
    expect((fetchSpy.mock.calls[2] as [string])[0]).toBe(
      'https://cue.buildd.dev/.well-known/oauth-protected-resource',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('throws unexpected-status when GET, POST, and well-known all fail', async () => {
    fetchSpy = spyOn(globalThis, 'fetch')
      // GET → 405
      .mockResolvedValueOnce(new Response('Method Not Allowed', { status: 405 }))
      // POST → 405 (no challenge)
      .mockResolvedValueOnce(new Response('Method Not Allowed', { status: 405 }))
      // Origin well-known → 404
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    await expect(
      discoverOAuthMetadata('https://cue.buildd.dev/api/mcp'),
    ).rejects.toThrow('unexpected status 405');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

// ─── buildAuthorizationUrl ────────────────────────────────────────────────────

describe('buildAuthorizationUrl', () => {
  const asMetadata: ASMetadata = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    scopes_supported: ['mcp:read', 'mcp:write'],
  };

  it('builds correct URL with required PKCE params', () => {
    const url = buildAuthorizationUrl(
      asMetadata,
      'my-client-id',
      'https://mcp.example.com',
      'random-state-hex',
      'code-challenge-base64url',
    );

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://auth.example.com/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('my-client-id');
    expect(parsed.searchParams.get('state')).toBe('random-state-hex');
    expect(parsed.searchParams.get('code_challenge')).toBe('code-challenge-base64url');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://buildd.test/api/connectors/callback');
  });

  it('includes AS scopes_supported when no explicit scopes given', () => {
    const url = buildAuthorizationUrl(
      asMetadata,
      'client-id',
      'https://mcp.example.com',
      'state',
      'challenge',
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('mcp:read mcp:write');
  });

  it('uses caller-supplied scopes over AS scopes', () => {
    const url = buildAuthorizationUrl(
      asMetadata,
      'client-id',
      'https://mcp.example.com',
      'state',
      'challenge',
      undefined,
      ['read'],
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('read');
  });

  it('omits scope when AS has none and none supplied', () => {
    const noScopeAS: ASMetadata = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
    };
    const url = buildAuthorizationUrl(noScopeAS, 'cid', 'https://mcp.example.com', 's', 'ch');
    expect(new URL(url).searchParams.has('scope')).toBe(false);
  });

  it('falls back to request origin for redirect_uri when no issuer env vars are set', () => {
    const original = {
      OAUTH_ISSUER: process.env.OAUTH_ISSUER,
      NEXTAUTH_URL: process.env.NEXTAUTH_URL,
      AUTH_URL: process.env.AUTH_URL,
    };
    delete process.env.OAUTH_ISSUER;
    delete process.env.NEXTAUTH_URL;
    delete process.env.AUTH_URL;
    try {
      const url = buildAuthorizationUrl(
        asMetadata,
        'client-id',
        'https://mcp.example.com',
        'state',
        'challenge',
        'https://preview-123.vercel.app',
      );
      expect(new URL(url).searchParams.get('redirect_uri')).toBe(
        'https://preview-123.vercel.app/api/connectors/callback',
      );
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});

// ─── validateTokenAudience ────────────────────────────────────────────────────

describe('validateTokenAudience', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.fakesig`;
  }

  it('passes when aud matches connector URL', () => {
    const token = makeJwt({ aud: 'https://mcp.example.com' });
    expect(() => validateTokenAudience(token, 'https://mcp.example.com')).not.toThrow();
  });

  it('passes when aud is an array containing the connector URL', () => {
    const token = makeJwt({ aud: ['https://other.example.com', 'https://mcp.example.com'] });
    expect(() => validateTokenAudience(token, 'https://mcp.example.com')).not.toThrow();
  });

  it('normalizes trailing slashes', () => {
    const token = makeJwt({ aud: 'https://mcp.example.com/' });
    expect(() => validateTokenAudience(token, 'https://mcp.example.com')).not.toThrow();

    const token2 = makeJwt({ aud: 'https://mcp.example.com' });
    expect(() => validateTokenAudience(token2, 'https://mcp.example.com/')).not.toThrow();
  });

  it('throws when aud does not match', () => {
    const token = makeJwt({ aud: 'https://wrong.example.com' });
    expect(() => validateTokenAudience(token, 'https://mcp.example.com')).toThrow(
      'Token audience mismatch',
    );
  });

  it('does not throw when aud is absent (permissive)', () => {
    const token = makeJwt({ sub: 'user' });
    expect(() => validateTokenAudience(token, 'https://mcp.example.com')).not.toThrow();
  });

  it('throws on invalid JWT format', () => {
    expect(() => validateTokenAudience('notajwt', 'https://mcp.example.com')).toThrow(
      'Invalid JWT format',
    );
  });
});

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

describe('PKCE helpers', () => {
  it('generateCodeVerifier produces a 43-char base64url string', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('deriveCodeChallenge produces reproducible S256 challenge', () => {
    // S256 challenge of 'verifier' is known value
    const challenge = deriveCodeChallenge('verifier');
    expect(typeof challenge).toBe('string');
    expect(challenge.length).toBeGreaterThan(30);
    // Verify it is deterministic
    expect(deriveCodeChallenge('verifier')).toBe(challenge);
    expect(deriveCodeChallenge('other')).not.toBe(challenge);
  });
});

// ─── signOAuthState / verifyOAuthState ────────────────────────────────────────

describe('signOAuthState / verifyOAuthState', () => {
  const claims = {
    state: 'abc123hex',
    connectorId: 'conn-uuid-1234',
    codeVerifier: 'pkce-verifier-value',
    userId: 'user-uuid-5678',
  };

  it('round-trips state claims', async () => {
    const token = await signOAuthState(claims);
    const decoded = await verifyOAuthState(token);
    expect(decoded).toEqual(claims);
  });

  it('returns null for tampered token', async () => {
    const token = await signOAuthState(claims);
    const tampered = token.slice(0, -3) + 'XXX';
    const result = await verifyOAuthState(tampered);
    expect(result).toBeNull();
  });

  it('returns null for completely invalid token', async () => {
    expect(await verifyOAuthState('not.a.valid.jwt')).toBeNull();
    expect(await verifyOAuthState('')).toBeNull();
  });
});

// ─── getCallbackUrl ───────────────────────────────────────────────────────────

describe('getCallbackUrl', () => {
  it('returns OAUTH_ISSUER-based callback URL', () => {
    const original = process.env.OAUTH_ISSUER;
    process.env.OAUTH_ISSUER = 'https://buildd.test';
    expect(getCallbackUrl()).toBe('https://buildd.test/api/connectors/callback');
    process.env.OAUTH_ISSUER = original;
  });

  it('prefers OAUTH_ISSUER over a supplied origin', () => {
    const original = process.env.OAUTH_ISSUER;
    process.env.OAUTH_ISSUER = 'https://buildd.test';
    expect(getCallbackUrl('https://buildd-git-some-branch.vercel.app')).toBe(
      'https://buildd.test/api/connectors/callback',
    );
    process.env.OAUTH_ISSUER = original;
  });

  it('falls back to the supplied origin when no issuer env vars are set', () => {
    const original = {
      OAUTH_ISSUER: process.env.OAUTH_ISSUER,
      NEXTAUTH_URL: process.env.NEXTAUTH_URL,
      AUTH_URL: process.env.AUTH_URL,
    };
    delete process.env.OAUTH_ISSUER;
    delete process.env.NEXTAUTH_URL;
    delete process.env.AUTH_URL;
    try {
      expect(getCallbackUrl('https://buildd-git-some-branch.vercel.app')).toBe(
        'https://buildd-git-some-branch.vercel.app/api/connectors/callback',
      );
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it('falls back to localhost:3000 when neither env vars nor origin are available', () => {
    const original = {
      OAUTH_ISSUER: process.env.OAUTH_ISSUER,
      NEXTAUTH_URL: process.env.NEXTAUTH_URL,
      AUTH_URL: process.env.AUTH_URL,
    };
    delete process.env.OAUTH_ISSUER;
    delete process.env.NEXTAUTH_URL;
    delete process.env.AUTH_URL;
    try {
      expect(getCallbackUrl()).toBe('http://localhost:3000/api/connectors/callback');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});

// ─── exchangeCodeForToken ─────────────────────────────────────────────────────

describe('exchangeCodeForToken', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('sends client_secret_basic when secret is provided', async () => {
    const tokenResponse = {
      access_token: 'at_test',
      token_type: 'bearer',
      expires_in: 3600,
    };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 }),
    );

    const result = await exchangeCodeForToken(
      'https://auth.example.com/token',
      'authcode123',
      'pkce-verifier',
      'client-id',
      'client-secret',
      'https://buildd.test/api/connectors/callback',
    );

    expect(result.access_token).toBe('at_test');
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Basic /);
    // Should NOT include client_id in body when using basic auth
    const body = new URLSearchParams(opts.body as string);
    expect(body.has('client_id')).toBe(false);
  });

  it('sends client_id in body when no secret (public client)', async () => {
    const tokenResponse = { access_token: 'at_pub', token_type: 'bearer' };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tokenResponse), { status: 200 }),
    );

    await exchangeCodeForToken(
      'https://auth.example.com/token',
      'authcode',
      'verifier',
      'pub-client-id',
      null,
      'https://buildd.test/api/connectors/callback',
    );

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    const body = new URLSearchParams(opts.body as string);
    expect(body.get('client_id')).toBe('pub-client-id');
  });

  it('throws on non-200 response', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('invalid_grant', { status: 400 }),
    );

    await expect(
      exchangeCodeForToken('https://auth.example.com/token', 'bad', 'v', 'c', null, 'https://cb'),
    ).rejects.toThrow('Token exchange failed (400)');
  });
});

// ─── registerClient ───────────────────────────────────────────────────────────

describe('registerClient', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('posts DCR payload and returns client credentials', async () => {
    const dcrResponse = {
      client_id: 'dyn-client-123',
      client_secret: 'dyn-secret-abc',
    };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(dcrResponse), { status: 201 }),
    );

    const result = await registerClient(
      'https://auth.example.com/register',
      'https://buildd.test/api/connectors/callback',
    );

    expect(result.client_id).toBe('dyn-client-123');
    expect(result.client_secret).toBe('dyn-secret-abc');

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.example.com/register');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body.redirect_uris).toContain('https://buildd.test/api/connectors/callback');
  });

  it('throws on registration failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad_request', { status: 400 }),
    );

    await expect(
      registerClient('https://auth.example.com/register', 'https://cb'),
    ).rejects.toThrow('DCR failed (400)');
  });
});
