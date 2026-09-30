import { describe, it, expect, mock, beforeEach } from 'bun:test';

const updates: Array<Record<string, unknown>> = [];
const mockFindFirst = mock(() => Promise.resolve(null as any));
const mockRecordSuccess = mock(() => Promise.resolve());

mock.module('@buildd/core/db', () => ({
  db: {
    query: { secrets: { findFirst: mockFindFirst } },
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  secrets: { id: 'id', teamId: 'teamId', purpose: 'purpose', workspaceId: 'workspaceId', userId: 'userId', updatedAt: 'updatedAt' },
}));
mock.module('@buildd/core/secrets', () => ({ decrypt: (v: string) => v }));
mock.module('./credential-health', () => ({ recordCredentialAuthSuccess: mockRecordSuccess }));

const {
  parseCloudflareCredential, maskCloudflareCredential, verifyCloudflareToken, verifyCloudflareCredential,
} = await import('./cloudflare-credential');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf_test_token_not_real_000000000000000000';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('parseCloudflareCredential', () => {
  it('accepts a JSON string and drops unknown keys', () => {
    const r = parseCloudflareCredential(JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT, extra: 'x' }));
    expect(r).toEqual({ ok: true, value: { apiToken: TOKEN, accountId: ACCOUNT } });
  });

  it('trims, unquotes and lowercases', () => {
    const r = parseCloudflareCredential({ apiToken: ` "${TOKEN}" `, accountId: ACCOUNT.toUpperCase(), aiGatewayId: 'buildd' });
    expect(r).toEqual({ ok: true, value: { apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: 'buildd' } });
  });

  it('rejects bad input with a message', () => {
    expect(parseCloudflareCredential('not json').ok).toBe(false);
    expect(parseCloudflareCredential({ accountId: ACCOUNT }).ok).toBe(false);
    expect(parseCloudflareCredential({ apiToken: TOKEN }).ok).toBe(false);
    expect(parseCloudflareCredential({ apiToken: TOKEN, accountId: 'nope' }).ok).toBe(false);
    expect(parseCloudflareCredential({ apiToken: 'has space in it and more chars', accountId: ACCOUNT }).ok).toBe(false);
    expect(parseCloudflareCredential({ apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: 'Bad Id' }).ok).toBe(false);
  });
});

describe('maskCloudflareCredential', () => {
  it('never includes the token', () => {
    const m = maskCloudflareCredential({ apiToken: TOKEN, accountId: ACCOUNT });
    expect(JSON.stringify(m)).not.toContain(TOKEN.slice(0, 10));
    expect(m).toEqual({ accountId: '0123…cdef', aiGatewayId: null, tokenHint: '…0000' });
  });
});

describe('verifyCloudflareToken', () => {
  it('accepts an account-owned token at the account endpoint', async () => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      return json(200, { success: true, result: { id: 'x', status: 'active' } });
    };
    const r = await verifyCloudflareToken({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(r).toMatchObject({ verified: true, tokenKind: 'account', tokenStatus: 'active' });
    expect(calls).toEqual([`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`]);
  });

  it('falls back to the user endpoint for a user token', async () => {
    const f = async (url: string) =>
      url.includes('/accounts/')
        ? json(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] })
        : json(200, { success: true, result: { id: 'x', status: 'active' } });
    const r = await verifyCloudflareToken({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(r).toMatchObject({ verified: true, tokenKind: 'user' });
  });

  it('sends the token only as a bearer header', async () => {
    let headers: Record<string, string> = {};
    const f = async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return json(200, { success: true, result: { status: 'active' } });
    };
    await verifyCloudflareToken({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reports a rejection from both endpoints', async () => {
    const f = async () => json(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] });
    const r = await verifyCloudflareToken({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(r).toMatchObject({ verified: false, rejected: true, error: 'HTTP 401: Invalid API Token' });
  });

  it('treats a disabled token as rejected', async () => {
    const f = async () => json(200, { success: true, result: { status: 'disabled' } });
    const r = await verifyCloudflareToken({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(r).toMatchObject({ verified: false, rejected: true, tokenStatus: 'disabled' });
  });

  it('a network error is not a rejection', async () => {
    const f = async () => { throw new Error('ECONNRESET'); };
    const r = await verifyCloudflareToken({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(r).toMatchObject({ verified: false, rejected: false, error: 'ECONNRESET' });
  });
});

describe('verifyCloudflareCredential', () => {
  beforeEach(() => {
    updates.length = 0;
    mockFindFirst.mockReset();
    mockRecordSuccess.mockReset();
    mockFindFirst.mockResolvedValue({ encryptedValue: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT }) });
  });

  it('records success as healthy', async () => {
    const r = await verifyCloudflareCredential('s1', async () => json(200, { success: true, result: { status: 'active' } }));
    expect(r.verified).toBe(true);
    expect(mockRecordSuccess).toHaveBeenCalledWith('s1');
    expect(updates[0]).toMatchObject({ lastVerificationError: null });
  });

  it('records a rejection as revoked', async () => {
    await verifyCloudflareCredential('s1', async () => json(403, { success: false, errors: [{ message: 'nope' }] }));
    expect(mockRecordSuccess).not.toHaveBeenCalled();
    expect(updates.some((u) => u.healthStatus === 'revoked')).toBe(true);
  });

  it('leaves health alone on a network error', async () => {
    await verifyCloudflareCredential('s1', async () => { throw new Error('offline'); });
    expect(updates.some((u) => 'healthStatus' in u)).toBe(false);
    expect(updates[0]).toMatchObject({ lastVerificationError: 'offline' });
  });

  it('not found', async () => {
    mockFindFirst.mockResolvedValue(null);
    expect((await verifyCloudflareCredential('s1')).error).toBe('Credential not found');
  });
});
