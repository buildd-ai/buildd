/**
 * Live, read-only OAuth discovery against the official Axiom and Vercel remote
 * MCP servers, run with buildd's own discovery code (lib/mcp-oauth.ts) as the
 * client. Confirms the catalog entries still point at servers buildd can
 * discover, and that each still advertises what buildd's connect flow relies on.
 *
 * Discovery only: no client registration, no sign-in, no credential. The DCR
 * outcomes (Axiom registers buildd; Vercel refuses buildd's web callback with
 * invalid_redirect_uri) are pinned as recorded fixtures in
 * lib/mcp-oauth.test.ts and lib/connector-provision.test.ts, because a live
 * DCR creates a client at the provider on every run.
 *
 * Opt-in — it depends on third-party uptime, so it never gates CI:
 *   BUILDD_LIVE_PROVIDER_PROBE=1 bun test apps/web/tests/integration/mcp-provider-discovery.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { discoverOAuthMetadata } from '../../src/lib/mcp-oauth';
import { catalogEntryBySlug } from '../../src/lib/connector-catalog';

const TIMEOUT = 20_000;

describe.skipIf(!process.env.BUILDD_LIVE_PROVIDER_PROBE)('live MCP provider discovery', () => {
  test('Axiom: OAuth discovery succeeds and offers DCR, PKCE S256 and refresh tokens', async () => {
    const entry = catalogEntryBySlug('axiom')!;
    expect(entry.url).toBe('https://mcp.axiom.co/mcp');
    expect(entry.clientSupport).toBeUndefined();

    const d = await discoverOAuthMetadata(entry.url);
    expect(d.authMode).toBe('oauth');
    if (d.authMode !== 'oauth') return;
    expect(d.authorizationServer.registration_endpoint).toBeTruthy();
    expect(d.authorizationServer.code_challenge_methods_supported).toContain('S256');
    expect(d.authorizationServer.grant_types_supported).toContain('refresh_token');
    expect(d.authorizationServer.scopes_supported).toContain('offline_access');
  }, TIMEOUT);

  test('Vercel: OAuth discovery succeeds; the catalog records that DCR needs Vercel approval', async () => {
    const entry = catalogEntryBySlug('vercel')!;
    expect(entry.url).toBe('https://mcp.vercel.com');
    expect(entry.clientSupport?.status).toBe('needs_approved_client');

    const d = await discoverOAuthMetadata(entry.url);
    expect(d.authMode).toBe('oauth');
    if (d.authMode !== 'oauth') return;
    expect(d.authorizationServer.registration_endpoint).toBeTruthy();
    expect(d.authorizationServer.code_challenge_methods_supported).toContain('S256');
  }, TIMEOUT);
});
