import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { signRequest } from '@buildd/dispatch-contract';

const mockRelay = mock(async (_req: unknown) => ({ status: 200, body: { outcome: 'delivered', via: 'relay:pusher' } }));
mock.module('@/lib/dispatch-resolve', () => ({ relayDispatch: mockRelay, resolveDispatch: async () => ({ status: 200, body: {} }) }));

const { POST } = await import('./route');

const PATH = '/api/dispatch/v1/relay';
const BODY = JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', attempt: 1, target: 'buildd:ws:11111111-1111-4111-8111-111111111111:runner-wake', payload: {} });
let saved: string | undefined;
beforeEach(() => { saved = process.env.DISPATCH_CALLBACK_SECRET; mockRelay.mockClear(); });
afterEach(() => { if (saved === undefined) delete process.env.DISPATCH_CALLBACK_SECRET; else process.env.DISPATCH_CALLBACK_SECRET = saved; });

async function signed(secret = 'cb-secret') {
  const headers = await signRequest({ keyId: 'k1', secret, method: 'POST', path: PATH, body: BODY });
  return new Request(`https://buildd.test${PATH}`, { method: 'POST', headers, body: BODY });
}

describe('POST /api/dispatch/v1/relay', () => {
  it('503 with no secret, 401 with a bad signature, and relay is never reached', async () => {
    delete process.env.DISPATCH_CALLBACK_SECRET;
    expect((await POST(await signed())).status).toBe(503);
    process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-secret';
    expect((await POST(await signed('nope'))).status).toBe(401);
    expect(mockRelay).not.toHaveBeenCalled();
  });

  it('a signed request relays, and a Pusher failure surfaces as 502 for Dispatch to retry', async () => {
    process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-secret';
    const ok = await POST(await signed());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ outcome: 'delivered', via: 'relay:pusher' });
    mockRelay.mockImplementationOnce(async () => ({ status: 502, body: { error: 'pusher send failed' } }) as never);
    expect((await POST(await signed())).status).toBe(502);
  });
});
