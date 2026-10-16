/**
 * `buildd login --device` ends on the runner consent page (spec "One runner
 * for every team you run", R-1). Loading it never changes the code; only
 * Connect runner approves, with the picks.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

process.env.OAUTH_JWT_SECRET = 'device-consent-test-secret-0123456789abcdef';
delete process.env.OAUTH_ISSUER;

const ORIGIN = 'http://localhost:3000';
const mockAuth = mock(async () => ({ user: { id: 'user-1' } }) as any);
const mockLookup = mock(async (_c: string, _u: string) => ({ ok: true, details: {} }) as any);
const mockApprove = mock(async (_a: any) => ({ ok: true, accountId: 'acct-new', level: 'worker', teamId: 'team-a' }) as any);
const teams = [
  { id: 'team-a', name: 'Alpha', role: 'owner', workspaces: [{ id: 'ws-a1', name: 'alpha-one', accessMode: 'open' }] },
  { id: 'team-b', name: 'Beta', role: 'member', workspaces: [{ id: 'ws-b1', name: 'beta-one', accessMode: 'open' }] },
];

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/device-confirm', () => ({
  lookupDeviceCodeForConfirm: mockLookup,
  normalizeUserCode: (c: string) => c.trim().toUpperCase(),
}));
mock.module('@/lib/device-approve', () => ({ approveDeviceCode: mockApprove }));
mock.module('@/lib/runner-picks', () => ({ runnerConsentTeams: async () => teams }));

const { GET, POST } = await import('./route');

function hiddenOf(html: string): Array<[string, string]> {
  return [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]] as [string, string]);
}
function post(fields: Array<[string, string]>) {
  return new NextRequest(`${ORIGIN}/api/auth/device/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
  mockApprove.mockClear();
  mockLookup.mockClear();
});

describe('/api/auth/device/consent', () => {
  it('GET renders the picker for a pending code and approves nothing', async () => {
    const res = await GET(new NextRequest(`${ORIGIN}/api/auth/device/consent?code=abcd-1234`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-consent="runner"');
    expect(html).toContain('ABCD-1234');
    expect(mockLookup).toHaveBeenCalledWith('ABCD-1234', 'user-1');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('GET with a used or unknown code goes back to the device page', async () => {
    mockLookup.mockResolvedValueOnce({ ok: false, reason: 'already_used' });
    const res = await GET(new NextRequest(`${ORIGIN}/api/auth/device/consent?code=ABCD-1234`));
    expect(res.headers.get('location')).toContain('/app/device?code=ABCD-1234');
  });

  it('Connect runner approves the code with the picks across teams', async () => {
    const page = await GET(new NextRequest(`${ORIGIN}/api/auth/device/consent?code=ABCD-1234`));
    const hidden = hiddenOf(await page.text());
    const res = await POST(post([...hidden, ['ws', 'ws-a1'], ['ws', 'ws-b1'], ['decision', 'approve']]));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Runner connected.');
    expect(mockApprove).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', code: 'ABCD-1234', workspaceIds: ['ws-a1', 'ws-b1'] }));
  });

  it('a tampered code is refused', async () => {
    const page = await GET(new NextRequest(`${ORIGIN}/api/auth/device/consent?code=ABCD-1234`));
    const hidden = hiddenOf(await page.text()).map(([k, v]) => [k, k === 'code' ? 'WXYZ-9999' : v] as [string, string]);
    const res = await POST(post([...hidden, ['ws', 'ws-a1'], ['decision', 'approve']]));
    expect(res.status).toBe(403);
    expect(mockApprove).not.toHaveBeenCalled();
  });
});
