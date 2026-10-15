import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(() => Promise.resolve({ user: { id: 'user-1' } } as any));
const mockApprove = mock(async (_a: any) => ({ ok: true, accountId: 'acct-new', level: 'worker', teamId: 'team-1' }) as any);
mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/device-approve', () => ({ approveDeviceCode: mockApprove }));

const route = await import('./route');
const { POST } = route;

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/auth/device/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
  mockApprove.mockClear();
});

describe('POST /api/auth/device/approve', () => {
  it('exposes no GET (or other non-POST) handler', () => {
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['POST']);
  });

  it('needs a signed-in person', async () => {
    mockAuth.mockResolvedValue(null as any);
    expect((await POST(req({ code: 'ABCD-1234', confirm: true, workspaceIds: ['ws-1'] }))).status).toBe(401);
  });

  it('refuses a post from another site, and changes nothing', async () => {
    const res = await POST(req({ code: 'ABCD-1234', confirm: true, workspaceIds: ['ws-1'] }, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('refuses a post with no Origin header', async () => {
    const r = new NextRequest('http://localhost:3000/api/auth/device/approve', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD-1234', confirm: true, workspaceIds: ['ws-1'] }),
    });
    expect((await POST(r)).status).toBe(403);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('refuses a code submitted without confirm: true and changes nothing', async () => {
    const res = await POST(req({ code: 'ABCD-1234', workspaceIds: ['ws-1'] }));
    expect(res.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('refuses a truthy-but-not-true confirm', async () => {
    const res = await POST(req({ code: 'ABCD-1234', confirm: 'yes', workspaceIds: ['ws-1'] }));
    expect(res.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  // Spec "One runner for every team you run", R-1: a device login names the
  // workspaces it claims from; there is no approval without picks.
  it('refuses an approval without picked workspaces', async () => {
    const res = await POST(req({ code: 'ABCD-1234', confirm: true }));
    expect(res.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('approves with the picks, the person, the IP and the user agent', async () => {
    const res = await POST(req(
      { code: 'abcd-1234', confirm: true, workspaceIds: ['ws-1', 'ws-2'] },
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'test-agent' },
    ));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockApprove).toHaveBeenCalledWith({
      userId: 'user-1', code: 'abcd-1234', workspaceIds: ['ws-1', 'ws-2'], ip: '203.0.113.7', userAgent: 'test-agent',
    });
  });

  it('passes a refusal through', async () => {
    mockApprove.mockResolvedValueOnce({ ok: false, status: 403, message: 'One of the chosen workspaces is not available to you.' });
    const res = await POST(req({ code: 'ABCD-1234', confirm: true, workspaceIds: ['ws-x'] }));
    expect(res.status).toBe(403);
  });
});
