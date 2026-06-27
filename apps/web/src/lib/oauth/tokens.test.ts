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
    // Flip a character in the signature.
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'AB' : 'AA');
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
    expect(looksLikeJwt('bld_535e8f83ca46ff20cdd7f90755da30b32ceb69eeb938904cb5fc1c3447889fa2')).toBe(false);
    expect(looksLikeJwt('')).toBe(false);
    expect(looksLikeJwt('not.a.valid.jwt.shape')).toBe(false);
  });
});
