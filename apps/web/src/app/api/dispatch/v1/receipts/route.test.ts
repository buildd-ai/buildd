import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { signRequest } from '@buildd/dispatch-contract';

const realHandoff = await import('@buildd/core/dispatch-handoff');
const mockApply = mock(async (r: unknown[]) => r.length);
mock.module('@buildd/core/dispatch-handoff', () => ({ ...realHandoff, applyReceipts: mockApply }));

const { POST } = await import('./route');

const PATH = '/api/dispatch/v1/receipts';
const A = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-03T12:00:00.000Z';
let saved: string | undefined;
beforeEach(() => { saved = process.env.DISPATCH_CALLBACK_SECRET; process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-secret'; mockApply.mockClear(); });
afterEach(() => { if (saved === undefined) delete process.env.DISPATCH_CALLBACK_SECRET; else process.env.DISPATCH_CALLBACK_SECRET = saved; });

async function signed(payload: unknown, secret = 'cb-secret') {
  const body = JSON.stringify(payload);
  const headers = await signRequest({ keyId: 'k1', secret, method: 'POST', path: PATH, body });
  return new Request(`https://buildd.test${PATH}`, { method: 'POST', headers, body });
}

describe('POST /api/dispatch/v1/receipts', () => {
  it('fails closed: 503 with no secret, 401 with a bad signature', async () => {
    delete process.env.DISPATCH_CALLBACK_SECRET;
    expect((await POST(await signed({ receipts: [] }))).status).toBe(503);
    process.env.DISPATCH_CALLBACK_SECRET = 'k1:cb-secret';
    expect((await POST(await signed({ receipts: [] }, 'nope'))).status).toBe(401);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('projects the well-formed receipts in one call and drops the rest', async () => {
    const res = await POST(await signed({ receipts: [
      { id: A, attempt: 1, event: 'delivered', via: 'webhook', at: AT },
      { id: 'nope', attempt: 1, event: 'delivered', at: AT },
      { id: A, attempt: 1, event: 'teleported', at: AT },
    ] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 1 });
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][0]).toEqual([{ id: A, attempt: 1, event: 'delivered', via: 'webhook', at: AT }]);
  });

  it('400 without a receipts array, 413 over the batch bound', async () => {
    expect((await POST(await signed({}))).status).toBe(400);
    const many = Array.from({ length: 501 }, () => ({ id: A, attempt: 1, event: 'attempted', at: AT }));
    expect((await POST(await signed({ receipts: many }))).status).toBe(413);
  });
});
