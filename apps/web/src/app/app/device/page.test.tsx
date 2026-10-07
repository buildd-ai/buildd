/**
 * Invariant: a device code is approved only by an explicit confirm.
 * Loading /app/device?code=X shows the confirm step and never approves.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const mockAuth = mock(() => Promise.resolve({ user: { id: 'user-1' } } as any));
const mockLookup = mock((_code: string, _userId: string) => Promise.resolve({ ok: false, reason: 'not_found' } as any));
const redirectCalls: string[] = [];

mock.module('@/auth', () => ({ auth: mockAuth }));
mock.module('@/lib/device-confirm', () => ({ lookupDeviceCodeForConfirm: mockLookup }));
mock.module('next/navigation', () => ({
  redirect: (url: string) => {
    redirectCalls.push(url);
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

const { default: DevicePage } = await import('./page');

const details = {
  userCode: 'ABCD-1234',
  clientName: 'buildd-runner@laptop',
  level: 'worker',
  requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  accountEmail: 'dev@example.com',
  teamName: 'Example Team',
};

const realFetch = globalThis.fetch;
let fetchCalls: unknown[][] = [];

async function renderPage(searchParams: Record<string, string>) {
  const el = await DevicePage({ searchParams: Promise.resolve(searchParams) });
  const html = renderToStaticMarkup(el);
  // Let any deferred work scheduled during render (setTimeout, microtasks) run.
  await new Promise(r => setTimeout(r, 10));
  return html;
}

describe('/app/device — loading the page never approves', () => {
  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockLookup.mockReset();
    redirectCalls.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('with a valid ?code= it renders the confirm step and sends no request', async () => {
    mockLookup.mockResolvedValue({ ok: true, details });
    const html = await renderPage({ code: 'abcd-1234' });
    expect(mockLookup).toHaveBeenCalledWith('abcd-1234', 'user-1');
    expect(fetchCalls).toHaveLength(0);
    expect(html).toContain('data-testid="device-confirm"');
    expect(html).toContain('data-testid="device-confirm-approve"');
    expect(html).not.toContain('data-testid="device-approved"');
  });

  it('shows the code, the client, when it was requested and the target account/team', async () => {
    mockLookup.mockResolvedValue({ ok: true, details });
    const html = await renderPage({ code: 'ABCD-1234' });
    expect(html).toMatch(/data-testid="device-confirm-code"[^>]*>ABCD-1234</);
    expect(html).toMatch(/data-testid="device-confirm-client"[^>]*>buildd-runner@laptop</);
    expect(html).toMatch(/data-testid="device-confirm-requested"[^>]*>2 minutes ago/);
    expect(html).toContain('Example Team (dev@example.com)');
    expect(html).toContain('Approve only if you started this sign-in yourself');
  });

  it('with no code it shows a GET entry form, never an approve action', async () => {
    const html = await renderPage({});
    expect(mockLookup).not.toHaveBeenCalled();
    expect(html).toContain('data-testid="device-code-entry"');
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).not.toContain('device-confirm-approve');
    expect(fetchCalls).toHaveLength(0);
  });

  it('an unknown or used code returns to the entry form with the reason', async () => {
    mockLookup.mockResolvedValue({ ok: false, reason: 'already_used' });
    const html = await renderPage({ code: 'ZZZZ-0000' });
    expect(html).toContain('already been used');
    expect(html).not.toContain('device-confirm-approve');
    expect(fetchCalls).toHaveLength(0);
  });

  it('a signed-out visitor is sent to sign in with the code preserved, and nothing is looked up', async () => {
    mockAuth.mockResolvedValue(null as any);
    await expect(renderPage({ code: 'ABCD-1234' })).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectCalls[0]).toBe(
      `/app/auth/signin?callbackUrl=${encodeURIComponent('/app/device?code=ABCD-1234')}`,
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
