// Tests for GET /api/../.well-known/oauth-authorization-server.
//
// NOT co-located: the unit-test runner's discovery glob skips dot directories,
// so a test inside `.well-known/` would never run. Three route handlers in this
// app live under a dot directory and this is the convention for testing them —
// see also apps/web/src/app/api/well-known-jwks-route.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { GET } from './.well-known/oauth-authorization-server/route';

const ISSUER = 'https://example.test';

describe('RFC 8414 authorization-server metadata', () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OAUTH_ISSUER;
    process.env.OAUTH_ISSUER = ISSUER;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.OAUTH_ISSUER;
    else process.env.OAUTH_ISSUER = prev;
  });

  // An RFC 8414 client discovers the key set through this document and nothing
  // else. The JWKS here does not sit at root `/.well-known/`, so there is no
  // conventional path to fall back on — omitting jwks_uri made the key set
  // undiscoverable and forced every client to hardcode it.
  it('advertises the JWKS location', async () => {
    const body = await (await GET()).json();
    expect(body.jwks_uri).toBe(`${ISSUER}/api/.well-known/jwks.json`);
  });

  // The assertion grant is implemented and reachable, so the metadata must not
  // tell clients it is unsupported.
  it('advertises the assertion grant alongside the interactive ones', async () => {
    const body = await (await GET()).json();
    expect(body.grant_types_supported).toContain('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(body.grant_types_supported).toContain('authorization_code');
    expect(body.grant_types_supported).toContain('refresh_token');
  });

  it('derives every advertised endpoint from the issuer', async () => {
    const body = await (await GET()).json();
    expect(body.issuer).toBe(ISSUER);
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string' && value.startsWith('http')) {
        expect(value, `${key} points off-issuer`).toStartWith(ISSUER);
      }
    }
  });
});
