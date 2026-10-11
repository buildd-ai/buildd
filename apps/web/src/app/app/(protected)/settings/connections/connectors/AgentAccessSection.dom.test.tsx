/**
 * Settings → Connected apps → Agent access in a browser (happy-dom): requests,
 * live grants, history and team policy. An admin decides and edits; a member
 * reads the same rows and gets no control. Every decision is the server's: the
 * row reports what the API answered, including a repeat or someone else's.
 * Runs in its own process (scripts/run-unit-tests.ts), so the globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections' });

import { describe, expect, it } from 'bun:test';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: AgentAccessSection } = await import('./AgentAccessSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom has no layout; the focus scroll is a no-op here.
(globalThis.HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};

const WS = { id: 'ws-1', name: 'web' };
const req = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'pending', capability: 'observability:query', provider: 'axiom', risk: 'query', tool: null, resource: null,
  environment: 'production', workspaceId: 'ws-1', taskId: 't-1', roleSlug: 'builder', decidedBy: null, ttlSeconds: 3600,
  expiresAt: null, revokedAt: null, reason: 'trace a slow endpoint', decisionReason: null, requestedAt: '2026-10-11T00:00:00Z', decidedAt: null,
  taskTitle: 'Fix checkout latency', workspaceName: 'web', decidedByName: null, ...over,
});

type Call = { url: string; method: string; body?: any };
function stubFetch(o: { requests: unknown[]; canDecide: boolean; rules?: unknown[]; canManage?: boolean; decide?: (body: any) => Response; policy?: () => Response }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    if (u.startsWith('/api/agent-capabilities/requests/')) return o.decide?.(body) ?? new Response(JSON.stringify({ grant: { status: 'granted' }, alreadyDecided: false }));
    if (u.startsWith('/api/agent-capabilities/requests')) return new Response(JSON.stringify({ requests: o.requests, canDecide: o.canDecide }));
    if (u.startsWith('/api/agent-capabilities/policy')) {
      if (method !== 'GET') return o.policy?.() ?? new Response(JSON.stringify({ rule: {} }));
      return new Response(JSON.stringify({ rules: o.rules ?? [], canManage: o.canManage ?? o.canDecide }));
    }
    if (u === '/api/connectors/catalog') return new Response(JSON.stringify({ entries: [{ slug: 'axiom', name: 'Axiom', policy: 'available' }, { slug: 'vercel', name: 'Vercel', policy: 'blocked' }] }));
    if (u === '/api/roles') return new Response(JSON.stringify({ roles: [{ slug: 'builder', name: 'Builder' }] }));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return calls;
}

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
async function mount(focusRequestId: string | null = null) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<AgentAccessSection teamId="team-1" workspaces={[WS]} focusRequestId={focusRequestId} />); });
  await flush(); await flush();
  return { el, unmount: async () => { await act(async () => root.unmount()); el.remove(); } };
}
const q = (el: ParentNode, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const button = (el: ParentNode, label: string | RegExp) => [...el.querySelectorAll('button')].find(b => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''))) as HTMLButtonElement | undefined;
const click = async (n: Element | undefined | null) => { await act(async () => { (n as HTMLElement).click(); }); await flush(); await flush(); };
const openDetails = (el: ParentNode) => click(button(el, /Allowed access, history and policy/));

describe('AgentAccessSection', () => {
  it('a pending request says who, what, where, why and for how long', async () => {
    stubFetch({ requests: [req('r1')], canDecide: true });
    const { el, unmount } = await mount();
    const row = q(el, 'access-request-r1')!;
    expect(row.textContent).toContain('Query Axiom · production');
    expect(row.textContent).toContain('Fix checkout latency in web');
    expect(row.textContent).toContain('trace a slow endpoint');
    expect(row.textContent).toContain('asks for 1 hour');
    await unmount();
  });

  it('a member sees requests and policy but cannot approve, deny, revoke or change policy', async () => {
    stubFetch({ requests: [req('r1'), req('g1', { status: 'granted', decidedBy: 'policy', expiresAt: '2099-01-01T00:00:00Z' })], canDecide: false, canManage: false });
    const { el, unmount } = await mount();
    expect(q(el, 'access-request-r1')).not.toBeNull();
    expect(q(el, 'access-member-note')).not.toBeNull();
    expect(button(el, /^Approve/)).toBeUndefined();
    expect(button(el, 'Deny')).toBeUndefined();
    await openDetails(el);
    expect(button(el, 'Revoke')).toBeUndefined();
    expect(q(el, 'access-policy-axiom-summary')!.textContent).toBe('Defaults');
    await click(button(el, /Axiom/));
    expect(q(el, 'access-policy-axiom-read')).toBeNull();
    expect(q(el, 'access-policy-axiom-write-value')!.textContent).toContain('Ask a person');
    expect(el.textContent).toContain('Only team owners and admins can change this.');
    expect(q(el, 'access-narrow-form')).toBeNull();
    await unmount();
  });

  it('an admin approves with the lease the agent asked for, and the list reloads', async () => {
    const calls = stubFetch({ requests: [req('r1')], canDecide: true });
    const { el, unmount } = await mount();
    await click(button(el, /^Approve/));
    const post = calls.find(c => c.url === '/api/agent-capabilities/requests/r1')!;
    expect(post.body).toEqual({ decision: 'approve', ttlSeconds: 3600 });
    expect(q(el, 'access-message')!.textContent).toContain('Approved.');
    expect(calls.filter(c => c.url.startsWith('/api/agent-capabilities/requests?')).length).toBe(2);
    await unmount();
  });

  it('approving twice is idempotent: the repeat reads as already approved, not an error', async () => {
    stubFetch({ requests: [req('r1')], canDecide: true, decide: () => new Response(JSON.stringify({ grant: { status: 'granted' }, alreadyDecided: true })) });
    const { el, unmount } = await mount();
    await click(button(el, /^Approve/));
    const msg = q(el, 'access-message')!;
    expect(msg.textContent).toContain('Already approved.');
    expect(msg.className).not.toContain('err');
    await unmount();
  });

  it('a decision someone else made first is reported as it stands', async () => {
    stubFetch({ requests: [req('r1')], canDecide: true, decide: () => new Response(JSON.stringify({ error: 'This request is already granted.', code: 'already_granted', grant: { status: 'granted' } }), { status: 409 }) });
    const { el, unmount } = await mount();
    await click(button(el, 'Deny'));
    expect(q(el, 'access-message')!.textContent).toContain('Someone already decided: this request is granted.');
    await unmount();
  });

  it('a refused approval says what to do (a forbidding policy)', async () => {
    stubFetch({ requests: [req('r1')], canDecide: true, decide: () => new Response(JSON.stringify({ error: 'Team capability policy forbids this access. Change the policy first.', code: 'policy_forbidden' }), { status: 409 }) });
    const { el, unmount } = await mount();
    await click(button(el, /^Approve/));
    expect(q(el, 'access-message')!.textContent).toContain('Change the policy first.');
    await unmount();
  });

  it('an admin revokes a live grant; history keeps who decided', async () => {
    const calls = stubFetch({
      requests: [
        req('g1', { status: 'granted', decidedBy: 'human', decidedByName: 'Sam', expiresAt: '2099-01-01T00:00:00Z' }),
        req('d1', { status: 'denied', decidedBy: 'human', decidedByName: 'Sam', decisionReason: 'use staging' }),
      ],
      canDecide: true,
    });
    const { el, unmount } = await mount();
    await openDetails(el);
    expect(q(el, 'access-request-g1')!.textContent).toContain('Approved by Sam');
    await click(button(el, /History/));
    expect(q(el, 'access-history')!.textContent).toContain('Denied by Sam: use staging');
    await click(button(el, 'Revoke'));
    expect(calls.find(c => c.url === '/api/agent-capabilities/requests/g1')!.body).toEqual({ decision: 'revoke' });
    await unmount();
  });

  it('an auto-granted request is informative: listed under Allowed now, never waiting', async () => {
    stubFetch({ requests: [req('g1', { status: 'granted', decidedBy: 'policy', expiresAt: '2099-01-01T00:00:00Z' })], canDecide: true });
    const { el, unmount } = await mount();
    expect(q(el, 'access-pending-empty')).not.toBeNull();
    expect(q(el, 'access-summary')!.textContent).toContain('1 allowed now.');
    await openDetails(el);
    expect(q(el, 'access-active')!.textContent).toContain('Allowed by team policy');
    await unmount();
  });

  it('policy: write offers no automatic allow, and a blocked provider has no controls', async () => {
    stubFetch({ requests: [], canDecide: true, canManage: true });
    const { el, unmount } = await mount();
    await openDetails(el);
    await click(button(el, /Axiom/));
    expect(q(el, 'access-policy-axiom-read')).not.toBeNull();
    expect(q(el, 'access-policy-vercel')!.textContent).toContain('Blocked in the catalog');
    expect(q(el, 'access-policy-vercel-read')).toBeNull();
    await unmount();
  });

  it('compact by default: waiting requests show, what agents hold and the policy stay folded', async () => {
    stubFetch({ requests: [req('r1'), req('g1', { status: 'granted', decidedBy: 'policy', expiresAt: '2099-01-01T00:00:00Z' })], canDecide: true });
    const { el, unmount } = await mount();
    expect(q(el, 'access-summary')!.textContent).toBe('1 waiting for a decision. 1 allowed now.');
    expect(q(el, 'access-request-r1')).not.toBeNull();
    expect(q(el, 'access-details')).toBeNull();
    expect(q(el, 'access-policy')).toBeNull();
    await unmount();
  });

  it('?request= pointing at a live grant opens the details to it', async () => {
    stubFetch({ requests: [req('g1', { status: 'granted', decidedBy: 'human', decidedByName: 'Sam', expiresAt: '2099-01-01T00:00:00Z' })], canDecide: true });
    const { el, unmount } = await mount('g1');
    expect(q(el, 'access-request-g1')!.getAttribute('aria-current')).toBe('true');
    await unmount();
  });
});
