import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TOKEN = 'cf_test_token_not_real_000000000000000000';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

const mockAuth = mock((_key: string | null) => Promise.resolve(null as any));
const mockFind = mock((_teamId: string) => Promise.resolve(null as any));
const mockAudit = mock((_row: any) => Promise.resolve('audit-1'));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuth }));
mock.module('@/lib/cloudflare-credential', () => ({
  findCloudflareSecret: mockFind,
  decodeCloudflareValue: (v: string) => JSON.parse(v),
}));
mock.module('@/lib/deployments/store', () => ({
  recordDeploymentAudit: mockAudit,
  credentialRefOf: (label: string | null, provider: string) => label?.trim().toLowerCase() || provider,
}));

import { POST } from './route';

const req = (auth?: string) =>
  new NextRequest('http://localhost:3000/api/cloudflare/credential/reveal', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
  });

describe('POST /api/cloudflare/credential/reveal', () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockFind.mockReset();
    mockAudit.mockReset();
    mockAudit.mockResolvedValue('audit-1');
    mockFind.mockResolvedValue({ id: 's1', healthStatus: 'healthy', encryptedValue: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }) });
  });

  it('refuses a request with no key, without looking anything up', async () => {
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('refuses a bearer that is not a bld_ key (OAuth JWTs, session tokens)', async () => {
    const res = await POST(req('Bearer eyJhbGciOiJIUzI1NiJ9.e30.x'));
    expect(res.status).toBe(401);
    expect(mockAuth).not.toHaveBeenCalled();
  });

  it('refuses a per-task token, whatever account minted it', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level: 'admin' });
    const res = await POST(req('Bearer bldt_payload.sig'));
    expect(res.status).toBe(401);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('refuses an unknown key', async () => {
    const res = await POST(req('Bearer bld_unknown'));
    expect(res.status).toBe(401);
    expect(mockFind).not.toHaveBeenCalled();
  });

  for (const level of ['worker', 'trigger']) {
    it(`refuses a ${level}-level key`, async () => {
      mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level });
      const res = await POST(req('Bearer bld_x'));
      expect(res.status).toBe(403);
      expect(mockFind).not.toHaveBeenCalled();
      expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
    });
  }

  it('returns the token to an admin key, for its own team only, uncached', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level: 'admin' });
    const res = await POST(req('Bearer bld_x'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockFind).toHaveBeenCalledWith('team-1');
    expect(await res.json()).toEqual({ apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: null, healthStatus: 'healthy' });
  });

  it('ignores a teamId in the query', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level: 'admin' });
    const r = new NextRequest('http://localhost:3000/api/cloudflare/credential/reveal?teamId=team-2', {
      method: 'POST', headers: { authorization: 'Bearer bld_x' },
    });
    await POST(r);
    expect(mockFind).toHaveBeenCalledWith('team-1');
  });

  it('audits the reveal as elevated secrets:reveal, naming the reference and never the value', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level: 'admin' });
    mockFind.mockResolvedValue({ id: 's1', label: 'Cloudflare-Prod', healthStatus: 'healthy', encryptedValue: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }) });
    const res = await POST(req('Bearer bld_x'));
    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const row = mockAudit.mock.calls[0][0];
    expect(row).toMatchObject({ teamId: 'team-1', accountId: 'a1', principal: 'admin', operation: 'reveal', capabilities: ['secrets:reveal'], elevated: true, credentialRef: 'cloudflare-prod' });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(ACCOUNT);
  });

  it('refuses to reveal when the audit row cannot be written', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level: 'admin' });
    mockAudit.mockRejectedValue(new Error('db down'));
    const res = await POST(req('Bearer bld_x'));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });

  it('does not audit a refused caller', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level: 'worker' });
    await POST(req('Bearer bld_x'));
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('404 when nothing is stored', async () => {
    mockAuth.mockResolvedValue({ id: 'a1', teamId: 'team-1', level: 'admin' });
    mockFind.mockResolvedValue(null);
    const res = await POST(req('Bearer bld_x'));
    expect(res.status).toBe(404);
  });
});
