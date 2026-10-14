/**
 * Settings' Edit (and `buildd login --workspaces`) reopens the runner consent
 * page with a key's current picks; saving replaces them and keeps the key
 * (spec "One runner for every team you run", R-4, AC-4).
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

process.env.OAUTH_JWT_SECRET = 'runner-picks-test-secret-0123456789abcdef';
delete process.env.OAUTH_ISSUER;

const ORIGIN = 'http://localhost:3000';
const KEY = '11111111-2222-4333-8444-555555555555';
const teams = [
  { id: 'team-a', name: 'Alpha', role: 'owner', workspaces: [{ id: 'ws-a1', name: 'alpha-one', accessMode: 'open' }] },
  { id: 'team-b', name: 'Beta', role: 'member', workspaces: [{ id: 'ws-b1', name: 'beta-one', accessMode: 'open' }] },
];
const mockAuth = mock(async () => ({ user: { id: 'user-1' } }) as any);
const mockList = mock(async (_u: string) => [{ id: KEY, name: 'Laptop', picks: [{ workspaceId: 'ws-a1' }] }] as any[]);
const mockReplace = mock(async (_a: any) => ({ ok: true, workspaceIds: ['ws-a1', 'ws-b1'] }) as any);

mock.module('@/auth', () => ({ auth: mockAuth }));
const mockEditTeams = mock(async (_u: string, _a: string) => ({ teams: teams as any[], removedNames: [] as string[] }));
mock.module('@/lib/runner-picks', () => ({ listRunnerKeys: mockList, replaceRunnerPicks: mockReplace, editConsentTeams: mockEditTeams }));

const { GET, POST } = await import('./route');

function hiddenOf(html: string): Array<[string, string]> {
  return [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]] as [string, string]);
}
function post(fields: Array<[string, string]>) {
  return new NextRequest(`${ORIGIN}/api/auth/runner-picks`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
  mockReplace.mockClear();
});

describe('/api/auth/runner-picks', () => {
  it("GET opens the picker with the key's current picks", async () => {
    const res = await GET(new NextRequest(`${ORIGIN}/api/auth/runner-picks?account=${KEY}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Change runner workspaces');
    expect(html).toContain('Laptop');
    expect(html).toContain('value="ws-a1" checked');
    expect(html).not.toContain('value="ws-b1" checked');
  });

  it('says which workspaces a team admin removed this runner from, and leaves them off the picker', async () => {
    mockEditTeams.mockResolvedValueOnce({ teams: [teams[0]] as any[], removedNames: ['beta-one'] });
    const html = await (await GET(new NextRequest(`${ORIGIN}/api/auth/runner-picks?account=${KEY}`))).text();
    expect(html).toContain('A team admin removed it from beta-one');
    expect(html).not.toContain('value="ws-b1"');
  });

  it("GET for a key the person did not mint is not found", async () => {
    mockList.mockResolvedValueOnce([]);
    expect((await GET(new NextRequest(`${ORIGIN}/api/auth/runner-picks?account=${KEY}`))).status).toBe(404);
  });

  it('Save replaces the picks on the same key and returns to Settings', async () => {
    const page = await GET(new NextRequest(`${ORIGIN}/api/auth/runner-picks?account=${KEY}`));
    const hidden = hiddenOf(await page.text());
    const res = await POST(post([...hidden, ['ws', 'ws-a1'], ['ws', 'ws-b1'], ['decision', 'approve']]));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/app/settings/connections');
    expect(mockReplace).toHaveBeenCalledWith({ accountId: KEY, userId: 'user-1', workspaceIds: ['ws-a1', 'ws-b1'] });
  });

  it("another person cannot submit the first person's page", async () => {
    const page = await GET(new NextRequest(`${ORIGIN}/api/auth/runner-picks?account=${KEY}`));
    const hidden = hiddenOf(await page.text());
    mockAuth.mockResolvedValue({ user: { id: 'user-2' } });
    expect((await POST(post([...hidden, ['ws', 'ws-a1'], ['decision', 'approve']]))).status).toBe(403);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
