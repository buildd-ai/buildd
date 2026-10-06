import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { signRequest } from '@buildd/dispatch-contract';

const mockResolve = mock(async (_req: unknown) => ({ status: 200, body: { decision: 'decline', why: 'webhook_not_wanted' } }));
mock.module('@/lib/dispatch-resolve', () => ({ resolveDispatch: mockResolve, relayDispatch: async () => ({ status: 200, body: {} }) }));

const { POST } = await import('./route');

const PATH = '/api/dispatch/v1/resolve';
const BODY = JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', attempt: 1, target: 'buildd:ws:11111111-1111-4111-8111-111111111111:webhook' });
let saved: string | undefined;
beforeEach(() => { saved = process.env.DISPATCH_CALLBACK_SECRET; mockResolve.mockClear(); });
afterEach(() => { if (saved === undefined) delete process.env.DISPATCH_CALLBACK_SECRET; else process.env.DISPATCH_CALLBACK_SECRET = saved; });

async function signed(opts: { keyId?: string; secret?: string; body?: string; path?: string; now?: number } = {}) {
  const body = opts.body ?? BODY;
  const headers = await signRequest({ keyId: opts.keyId ?? 'k1', secret: opts.secret ?? 'cb-secret', method: 'POST', path: opts.path ?? PATH, body, now: opts.now });
  return new Request(`https://buildd.test${PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
}

describe('POST /api/dispatch/v1/resolve', () => {
  it('fails closed with 503 when no callback secret is configured', async () => {
    delete process.env.DISPATCH_CALLBACK_SECRET;
    const res = await POST(await signed());
    expect(res.status).toBe(503);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('401 on a missing, wrong, stale or path-mismatched signature', async () => {
    process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-secret';
    expect((await POST(new Request(`https://buildd.test${PATH}`, { method: 'POST', body: BODY }))).status).toBe(401);
    expect((await POST(await signed({ secret: 'wrong' }))).status).toBe(401);
    expect((await POST(await signed({ keyId: 'k9' }))).status).toBe(401);
    expect((await POST(await signed({ now: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401);
    expect((await POST(await signed({ path: '/api/dispatch/v1/relay' }))).status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('a body altered after signing is refused', async () => {
    process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-secret';
    const req = await signed();
    const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: BODY.replace('"attempt":1', '"attempt":2') });
    expect((await POST(tampered)).status).toBe(401);
  });

  it('a valid signature (either key of a rotating ring) reaches resolve with the parsed body', async () => {
    process.env.DISPATCH_CALLBACK_SECRET = 'k2:new-secret,k1:cb-secret';
    const res = await POST(await signed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision: 'decline', why: 'webhook_not_wanted' });
    expect(mockResolve.mock.calls[0][0]).toEqual(JSON.parse(BODY));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await POST(await signed({ keyId: 'k2', secret: 'new-secret' }))).status).toBe(200);
  });

  it('passes the decision status through', async () => {
    process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-secret';
    mockResolve.mockImplementationOnce(async () => ({ status: 404, body: { error: 'unknown dispatch id' } }) as never);
    expect((await POST(await signed())).status).toBe(404);
  });
});
