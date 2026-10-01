import { describe, expect, it } from 'bun:test';
import { cloudflareState, type CloudflareCredentialView } from './cloudflare-state';

const cred = (over: Partial<CloudflareCredentialView> = {}): CloudflareCredentialView => ({
  id: 'c1', accountId: '0123…cdef', aiGatewayId: null, tokenHint: '…0000', readable: true,
  healthStatus: 'unknown', lastVerifiedAt: null, lastVerificationError: null, createdAt: new Date(0).toISOString(), ...over,
});

describe('cloudflareState', () => {
  it('gives each state exactly one next step', () => {
    expect(cloudflareState(null)).toMatchObject({ kind: 'empty', next: 'Add token' });
    expect(cloudflareState(cred())).toMatchObject({ kind: 'unverified', next: 'Verify' });
    expect(cloudflareState(cred({ healthStatus: 'healthy' }))).toMatchObject({ kind: 'verified', next: 'Deploy', tone: 'ok' });
    expect(cloudflareState(cred({ healthStatus: 'revoked' }))).toMatchObject({ kind: 'rejected', next: 'Replace', tone: 'err' });
    expect(cloudflareState(cred({ healthStatus: 'degraded' }))).toMatchObject({ kind: 'degraded', next: 'Verify' });
  });

  it('an unreadable token must be replaced, whatever its health says', () => {
    expect(cloudflareState(cred({ readable: false, healthStatus: 'healthy' }))).toMatchObject({ kind: 'unreadable', next: 'Replace' });
  });
});
