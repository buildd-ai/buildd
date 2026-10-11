// Tests for GET /.well-known/oauth-protected-resource/api/mcp (RFC 9728).
//
// NOT co-located: the unit-test runner's discovery glob skips dot directories
// (see well-known-oauth-authorization-server-route.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { GET } from './.well-known/oauth-protected-resource/api/mcp/route';
import { GET as getWorkspaceMetadata } from './.well-known/oauth-protected-resource/api/mcp-oauth/[workspace]/route';
import { GET as getServerMetadata } from './.well-known/oauth-authorization-server/route';

const ISSUER = 'https://example.test';

describe('account-level protected-resource metadata', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.OAUTH_ISSUER; process.env.OAUTH_ISSUER = ISSUER; });
  afterEach(() => { if (prev === undefined) delete process.env.OAUTH_ISSUER; else process.env.OAUTH_ISSUER = prev; });

  it('names the account-level resource and this issuer', async () => {
    const body = await (await GET()).json();
    expect(body.resource).toBe(`${ISSUER}/api/mcp`);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual(['mcp', 'buildd:read', 'buildd:write']);
  });

  it('does not advertise the act-as-person scope, here or on the server', async () => {
    expect((await (await GET()).json()).scopes_supported).not.toContain('buildd:act-as-person');
    expect((await (await getServerMetadata()).json()).scopes_supported).not.toContain('buildd:act-as-person');
  });

  it('keeps the per-workspace metadata unchanged', async () => {
    const body = await (await getWorkspaceMetadata(new Request(`${ISSUER}/x`), { params: Promise.resolve({ workspace: 'ws-1' }) })).json();
    expect(body.resource).toBe(`${ISSUER}/api/mcp-oauth/ws-1`);
    expect(body.scopes_supported).toEqual(['mcp']);
  });

  it('the server advertises the account scopes alongside mcp', async () => {
    const body = await (await getServerMetadata()).json();
    expect(body.scopes_supported).toEqual(['mcp', 'buildd:read', 'buildd:write']);
  });
});
