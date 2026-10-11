import { describe, it, expect, beforeAll, mock } from 'bun:test';

beforeAll(() => {
  // Clear any stale module mocks from previously-run test files (e.g. api-auth.test.ts
  // mocks './oauth/tokens' and may not have fully restored before this file runs).
  mock.restore();
  process.env.OAUTH_JWT_SECRET = 'test-secret-do-not-use-in-prod-test-secret-do-not-use';
  process.env.OAUTH_ISSUER = 'https://buildd.test';
});

describe('OAuth tokens', () => {
  it('round-trips workspace-scoped access token', async () => {
    const { signAccessToken, verifyAccessToken } = await import('./tokens');
    const { token } = await signAccessToken({
      userId: '00000000-0000-0000-0000-000000000001',
      workspaceId: '00000000-0000-0000-0000-000000000aaa',
      clientId: 'c_test',
      scope: 'mcp',
    });
    const claims = await verifyAccessToken(token, '00000000-0000-0000-0000-000000000aaa');
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('00000000-0000-0000-0000-000000000001');
    expect(claims!.workspace_id).toBe('00000000-0000-0000-0000-000000000aaa');
    expect(claims!.scope).toBe('mcp');
  });

  it('rejects token used against the wrong workspace', async () => {
    const { signAccessToken, verifyAccessToken } = await import('./tokens');
    const { token } = await signAccessToken({
      userId: '00000000-0000-0000-0000-000000000001',
      workspaceId: '00000000-0000-0000-0000-000000000aaa',
      clientId: 'c_test',
      scope: 'mcp',
    });
    const claims = await verifyAccessToken(token, '00000000-0000-0000-0000-000000000bbb');
    expect(claims).toBeNull();
  });

  it('rejects token with tampered signature', async () => {
    const { signAccessToken, verifyAccessToken } = await import('./tokens');
    const { token } = await signAccessToken({
      userId: '00000000-0000-0000-0000-000000000001',
      workspaceId: '00000000-0000-0000-0000-000000000aaa',
      clientId: 'c_test',
      scope: 'mcp',
    });
    // Flip a character in the middle of the signature. Not the last one: its
    // low bits are base64url padding, so some edits there decode to the same
    // bytes and the token still verifies.
    const i = token.length - 10;
    const tampered = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
    const claims = await verifyAccessToken(tampered, '00000000-0000-0000-0000-000000000aaa');
    expect(claims).toBeNull();
  });

  it('verifyAccessTokenAnyAudience extracts claims regardless of workspace', async () => {
    const { signAccessToken, verifyAccessTokenAnyAudience } = await import('./tokens');
    const { token } = await signAccessToken({
      userId: '00000000-0000-0000-0000-000000000001',
      workspaceId: '00000000-0000-0000-0000-000000000aaa',
      clientId: 'c_test',
      scope: 'mcp',
    });
    const claims = await verifyAccessTokenAnyAudience(token);
    expect(claims).not.toBeNull();
    expect(claims!.workspace_id).toBe('00000000-0000-0000-0000-000000000aaa');
  });

  it('looksLikeJwt distinguishes JWT bearer from bld_ key', async () => {
    const { looksLikeJwt } = await import('./tokens');
    expect(looksLikeJwt('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature')).toBe(true);
    expect(looksLikeJwt('bld_0000000000000000000000000000000000000000000000000000000000000000')).toBe(false);
    expect(looksLikeJwt('')).toBe(false);
    expect(looksLikeJwt('not.a.valid.jwt.shape')).toBe(false);
  });

  it('a grant token names a grant, never a workspace, and is refused by the workspace verifier', async () => {
    const { signGrantAccessToken, verifyAccessToken, verifyAccessTokenAnyAudience, isGrantClaims, looksLikeGrantToken } = await import('./tokens');
    const { token } = await signGrantAccessToken({
      userId: '00000000-0000-0000-0000-000000000001',
      grantId: '00000000-0000-0000-0000-00000000f001',
      clientId: 'c_test',
      scope: 'mcp',
    });
    const claims = await verifyAccessTokenAnyAudience(token);
    expect(claims && isGrantClaims(claims)).toBe(true);
    expect((claims as Record<string, unknown>).workspace_id).toBeUndefined();
    expect(looksLikeGrantToken(token)).toBe(true);
    expect(await verifyAccessToken(token, '00000000-0000-0000-0000-000000000aaa')).toBeNull();
  });

  it('refuses a token naming both a workspace and a grant, or a grant at a workspace audience', async () => {
    const { SignJWT } = await import('jose');
    const { verifyAccessTokenAnyAudience } = await import('./tokens');
    const { getJwtSecret, getIssuer, getResourceUrl, getAccountResourceUrl } = await import('./config');
    const sign = (claims: Record<string, unknown>, aud: string) => new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' }).setSubject('00000000-0000-0000-0000-000000000001')
      .setIssuer(getIssuer()).setAudience(aud).setIssuedAt().setExpirationTime('60s').sign(getJwtSecret());
    const base = { scope: 'mcp', client_id: 'c_test' };
    expect(await verifyAccessTokenAnyAudience(await sign({ ...base, workspace_id: 'ws', grant_id: 'g' }, getAccountResourceUrl()))).toBeNull();
    expect(await verifyAccessTokenAnyAudience(await sign(base, getAccountResourceUrl()))).toBeNull();
    expect(await verifyAccessTokenAnyAudience(await sign({ ...base, grant_id: 'g' }, getResourceUrl('ws')))).toBeNull();
    expect(await verifyAccessTokenAnyAudience(await sign({ ...base, grant_id: 'g' }, getAccountResourceUrl()))).not.toBeNull();
  });
});
