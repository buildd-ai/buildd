import { describe, expect, it } from 'bun:test';

process.env.OAUTH_ISSUER = 'https://buildd.dev';
const { resourceMatchesBinding } = await import('./resource-binding');

const WS = '0b6f3a52-6d0e-4d8e-9a43-2f1c7e5b9a10';
const OTHER = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const ACCOUNT = 'https://buildd.dev/api/mcp';
const legacy = (id: string) => `https://buildd.dev/api/mcp-oauth/${id}`;

describe('token endpoint resource binding (RFC 8707)', () => {
  it('no resource always defers to the binding', () => {
    expect(resourceMatchesBinding(null, { grantId: 'g' }, 'authorization_code')).toBe(true);
    expect(resourceMatchesBinding(null, { workspaceId: WS }, 'authorization_code')).toBe(true);
  });
  it('a grant code or refresh only for the account resource', () => {
    expect(resourceMatchesBinding(ACCOUNT, { grantId: 'g' }, 'authorization_code')).toBe(true);
    expect(resourceMatchesBinding(`${ACCOUNT}/`, { grantId: 'g' }, 'refresh_token')).toBe(true);
    expect(resourceMatchesBinding(legacy(WS), { grantId: 'g' }, 'authorization_code')).toBe(false);
    expect(resourceMatchesBinding(legacy(WS), { grantId: 'g' }, 'refresh_token')).toBe(false);
    expect(resourceMatchesBinding('https://evil.example/api/mcp', { grantId: 'g' }, 'refresh_token')).toBe(false);
  });
  it('a workspace code only for that workspace\'s own older address', () => {
    expect(resourceMatchesBinding(legacy(WS), { workspaceId: WS }, 'authorization_code')).toBe(true);
    expect(resourceMatchesBinding(legacy(OTHER), { workspaceId: WS }, 'authorization_code')).toBe(false);
    expect(resourceMatchesBinding(ACCOUNT, { workspaceId: WS }, 'authorization_code')).toBe(false);
  });
  it('a workspace refresh keeps working whatever resource an older connection sends', () => {
    expect(resourceMatchesBinding(ACCOUNT, { workspaceId: WS }, 'refresh_token')).toBe(true);
    expect(resourceMatchesBinding(legacy(OTHER), { workspaceId: WS }, 'refresh_token')).toBe(true);
  });
});
