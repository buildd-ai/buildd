/**
 * `buildd login` in the browser (spec "One runner for every team you run",
 * R-1, R-2): the CLI's URL now ends on the runner consent page, and only
 * pressing Connect runner mints the key and returns it to the CLI's
 * localhost callback, in the same redirect shape as before, so the CLI needs
 * no change.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

process.env.OAUTH_JWT_SECRET = 'cli-route-test-secret-0123456789abcdef';
delete process.env.OAUTH_ISSUER;

const mockAuth = mock(() => Promise.resolve({ user: { id: 'user-1', email: 'u@example.test' } } as any));
const teams = [
  { id: 'team-a', name: 'Alpha', role: 'owner', workspaces: [{ id: 'ws-a1', name: 'alpha-one', accessMode: 'open' }] },
  { id: 'team-b', name: 'Beta', role: 'member', workspaces: [{ id: 'ws-b1', name: 'beta-one', accessMode: 'open' }] },
];
const mockConsentTeams = mock(async (_userId: string) => teams as any[]);
const mockMint = mock(async (_args: any) => ({
  ok: true, plaintextKey: 'bld_minted', accountId: 'acct-new', level: 'worker', teamId: 'team-a', workspaceIds: ['ws-a1'],
}) as any);

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/runner-picks', () => ({ runnerConsentTeams: mockConsentTeams, mintRunnerKey: mockMint }));
mock.module('@/lib/presence-token', () => ({ issuePresenceToken: async () => null }));

const { GET, POST } = await import('./route');

const ORIGIN = 'http://localhost:3000';

function cliReq(params: Record<string, string>) {
  const qs = new URLSearchParams({ callback: 'http://localhost:9876/callback', ...params });
  return new NextRequest(`${ORIGIN}/api/auth/cli?${qs.toString()}`);
}

/** The hidden fields of the rendered consent form, as the browser would post them. */
function hiddenOf(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    out.push([m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"')]);
  }
  return out;
}

function post(fields: Array<[string, string]>, headers: Record<string, string> = { origin: ORIGIN }) {
  return new NextRequest(`${ORIGIN}/api/auth/cli`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function consentFor(params: Record<string, string>) {
  const res = await GET(cliReq(params));
  expect(res.status).toBe(200);
  return hiddenOf(await res.text());
}

beforeEach(() => {
  mockAuth.mockReset();
  mockAuth.mockResolvedValue({ user: { id: 'user-1', email: 'u@example.test' } });
  mockConsentTeams.mockClear();
  mockMint.mockClear();
});

describe('GET /api/auth/cli', () => {
  it('refuses a callback that is not localhost', async () => {
    const res = await GET(cliReq({ callback: 'https://evil.example/cb' }));
    expect(res.status).toBe(400);
  });

  it('sends a signed-out person to sign in, then back here', async () => {
    mockAuth.mockResolvedValue(null as any);
    const res = await GET(cliReq({ client: 'runner' }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/app/auth/signin?callbackUrl=');
  });

  it('renders the runner consent page with every team, and mints nothing', async () => {
    const res = await GET(cliReq({ client: 'runner' }));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('data-consent="runner"');
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
    expect(mockConsentTeams).toHaveBeenCalledWith('user-1');
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('returns an error to the CLI when the person has no workspace to pick', async () => {
    mockConsentTeams.mockResolvedValueOnce([]);
    const res = await GET(cliReq({ client: 'runner' }));
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('No workspaces available');
  });
});

describe('POST /api/auth/cli', () => {
  it('mints a key for the picks across teams and returns it to the callback, as before', async () => {
    const hidden = await consentFor({ client: 'runner', level: 'admin' });
    const res = await POST(post([...hidden, ['ws', 'ws-a1'], ['ws', 'ws-b1'], ['decision', 'approve']]));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('http://localhost:9876/callback');
    expect(loc.searchParams.get('token')).toBe('bld_minted');
    expect(loc.searchParams.get('level')).toBe('worker');
    expect(loc.searchParams.get('email')).toBe('u@example.test');
    expect(mockMint).toHaveBeenCalledWith({ userId: 'user-1', workspaceIds: ['ws-a1', 'ws-b1'], name: 'Runner', requestedLevel: 'admin' });
  });

  it('uses the client default level and a custom name', async () => {
    const hidden = await consentFor({ client: 'cli', account_name: 'Laptop' });
    await POST(post([...hidden, ['ws', 'ws-a1'], ['decision', 'approve']]));
    expect(mockMint).toHaveBeenCalledWith(expect.objectContaining({ name: 'Laptop', requestedLevel: 'admin' }));
  });

  it('Cancel returns access_denied to the CLI and mints nothing', async () => {
    const hidden = await consentFor({ client: 'runner' });
    const res = await POST(post([...hidden, ['decision', 'deny']]));
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('a page action re-renders and mints nothing', async () => {
    const hidden = await consentFor({ client: 'runner' });
    const res = await POST(post([...hidden, ['nav', 'select_all']]));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('value="ws-b1" checked');
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('refuses a workspace the page did not offer', async () => {
    const hidden = await consentFor({ client: 'runner' });
    const res = await POST(post([...hidden, ['ws', 'ws-not-offered'], ['decision', 'approve']]));
    expect(res.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('refuses a post from another origin', async () => {
    const hidden = await consentFor({ client: 'runner' });
    const res = await POST(post([...hidden, ['ws', 'ws-a1'], ['decision', 'approve']], { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it('refuses a form whose parameters were changed after the page was rendered', async () => {
    const hidden = (await consentFor({ client: 'runner', level: 'worker' })).map(([k, v]) => [k, k === 'level' ? 'admin' : v] as [string, string]);
    const res = await POST(post([...hidden, ['ws', 'ws-a1'], ['decision', 'approve']]));
    expect(res.status).toBe(403);
    expect(mockMint).not.toHaveBeenCalled();
  });

  it("refuses another person's page", async () => {
    const hidden = await consentFor({ client: 'runner' });
    mockAuth.mockResolvedValue({ user: { id: 'user-2', email: 'x@example.test' } });
    const res = await POST(post([...hidden, ['ws', 'ws-a1'], ['decision', 'approve']]));
    expect(res.status).toBe(403);
  });

  it('refuses a non-localhost callback even with a valid form', async () => {
    const res = await POST(post([['callback', 'https://evil.example/cb'], ['decision', 'approve']]));
    expect(res.status).toBe(400);
  });
});
