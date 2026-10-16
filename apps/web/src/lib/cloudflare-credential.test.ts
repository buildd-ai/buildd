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
  checkCloudflareCapabilities, describeCloudflareCapability,
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

// Cloudflare's answer for an active token that lacks a permission: 401, code 10000.
const CF_AUTH_ERROR = { success: false, errors: [{ code: 10000, message: 'Authentication error' }] };
const ACTIVE = { success: true, result: { id: 'x', status: 'active' } };

/** A fake Cloudflare: the token is active; Workers AI and the gateway answer as given. */
function cloudflare(opts: { workersAi?: number; gateway?: number } = {}) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/tokens/verify')) return json(200, ACTIVE);
    if (url.includes('/ai/models/search')) return opts.workersAi === 200 || opts.workersAi === undefined ? json(200, { success: true, result: [] }) : json(opts.workersAi, CF_AUTH_ERROR);
    if (url.includes('/ai-gateway/gateways/')) return opts.gateway === 200 || opts.gateway === undefined ? json(200, { success: true, result: { id: 'buildd' } }) : json(opts.gateway, opts.gateway === 404 ? { success: false, errors: [{ code: 7002, message: 'Not Found' }] } : CF_AUTH_ERROR);
    return json(404, {});
  };
  return { f, calls };
}

describe('checkCloudflareCapabilities', () => {
  it('reports Workers AI allowed, and no gateway check without a gateway id', async () => {
    const { f, calls } = cloudflare();
    const caps = await checkCloudflareCapabilities({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(caps).toEqual({ workersAi: { state: 'allowed' }, aiGateway: null });
    expect(calls).toEqual([`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search?per_page=1`]);
  });

  it("reports Workers AI not allowed with Cloudflare's words, and says what to add", async () => {
    const { f } = cloudflare({ workersAi: 401 });
    const caps = await checkCloudflareCapabilities({ apiToken: TOKEN, accountId: ACCOUNT }, f);
    expect(caps.workersAi).toEqual({ state: 'not_allowed', detail: 'HTTP 401: Authentication error (code 10000)' });
    expect(describeCloudflareCapability('workersAi', caps.workersAi)).toBe('Workers AI: not allowed (add Workers AI Read to this token)');
    expect(describeCloudflareCapability('workersAi', { state: 'allowed' })).toBe('Workers AI: allowed');
  });

  it('checks the AI Gateway when a gateway id is set', async () => {
    const ok = cloudflare();
    expect((await checkCloudflareCapabilities({ apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: 'buildd' }, ok.f)).aiGateway).toEqual({ state: 'allowed' });
    expect(ok.calls).toContain(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai-gateway/gateways/buildd`);

    const denied = await checkCloudflareCapabilities({ apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: 'buildd' }, cloudflare({ gateway: 403 }).f);
    expect(describeCloudflareCapability('aiGateway', denied.aiGateway!)).toBe('AI Gateway: not allowed (add AI Gateway Read to this token)');

    const missing = await checkCloudflareCapabilities({ apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: 'buildd' }, cloudflare({ gateway: 404 }).f);
    expect(describeCloudflareCapability('aiGateway', missing.aiGateway!)).toBe('AI Gateway: not found (check the AI Gateway ID)');
  });

  it('a network error or a 5xx is unknown, not a refusal', async () => {
    const caps = await checkCloudflareCapabilities({ apiToken: TOKEN, accountId: ACCOUNT }, async () => { throw new Error('ECONNRESET'); });
    expect(caps.workersAi).toEqual({ state: 'unknown', detail: 'ECONNRESET' });
    expect(describeCloudflareCapability('workersAi', caps.workersAi)).toBe('Workers AI: could not check (ECONNRESET)');
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

  it('an active token without Workers AI is still verified, but says so, and keeps saying so after a reload', async () => {
    const r = await verifyCloudflareCredential('s1', cloudflare({ workersAi: 401 }).f);
    expect(r.verified).toBe(true);
    expect(r.capabilities?.workersAi).toMatchObject({ state: 'not_allowed' });
    expect(mockRecordSuccess).toHaveBeenCalledWith('s1');
    // Stored on the row, so the card shows it after a reload, not only after Verify.
    expect(updates[0]).toMatchObject({ lastVerificationError: 'Workers AI: not allowed (add Workers AI Read to this token)' });
  });

  it('reports the capabilities on a fully allowed token', async () => {
    mockFindFirst.mockResolvedValue({ encryptedValue: JSON.stringify({ apiToken: TOKEN, accountId: ACCOUNT, aiGatewayId: 'buildd' }) });
    const r = await verifyCloudflareCredential('s1', cloudflare().f);
    expect(r.capabilities).toEqual({ workersAi: { state: 'allowed' }, aiGateway: { state: 'allowed' } });
    expect(updates[0]).toMatchObject({ lastVerificationError: null });
  });

  it('a rejected token is not probed for capabilities', async () => {
    const calls: string[] = [];
    const r = await verifyCloudflareCredential('s1', async (url: string) => { calls.push(url); return json(401, { success: false, errors: [{ message: 'Invalid API Token' }] }); });
    expect(r.capabilities).toBeUndefined();
    expect(calls.every((u) => u.endsWith('/tokens/verify'))).toBe(true);
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
