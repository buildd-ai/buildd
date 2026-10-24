/**
 * Approving specs from a session (Living Spec b7fc9316, R-7, R-8, R-11):
 * - manage_specs awaiting_approval is a read: a count and the inbox link,
 *   never a confirm token (AC-5);
 * - approve from an OAuth session still only asks, and names the inbox;
 *   an API key's 403 names the inbox and the spec page (AC-6);
 * - retire and restore from an OAuth session return a confirm link and say
 *   nothing changed (AC-8).
 * The rules behind each reply are real-Postgres tested in
 * apps/web/tests/db/spec-approval-inbox.test.ts.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, buildParamsDescription, type ApiFn, type ActionContext } from '../mcp-tools';
import { requiredScopeForAction } from '../token-scopes';
import { SUB_ACTIONS } from '../mcp-sub-actions';

const WS = '00000000-0000-0000-0000-000000000001';
const SPEC = '00000000-0000-4000-8000-000000000081';
const INBOX = 'https://buildd.dev/app/specs/approvals';
const ctx = (o: Partial<ActionContext> = {}): ActionContext => ({ workspaceId: WS, getWorkspaceId: async () => WS, getLevel: async () => 'worker', ...o });
const out = (r: any) => String(r.content[0].text);
const call = (api: unknown, params: Record<string, unknown>) => handleBuilddAction(api as ApiFn, 'manage_specs', params, ctx());

describe('manage_specs awaiting_approval', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('is a registered, documented, read-only sub-action', () => {
    expect(SUB_ACTIONS.manage_specs).toContain('awaiting_approval');
    expect(requiredScopeForAction('manage_specs', { action: 'awaiting_approval' })).toBe('tasks:read');
    expect(buildParamsDescription(['manage_specs'])).toContain('awaiting_approval');
  });

  it('AC-5: from a person\'s session, the count waiting on them and the inbox link, and no token', async () => {
    api.mockResolvedValueOnce({ count: 3, scope: 'person', inboxUrl: INBOX });
    const r = out(await call(api, { action: 'awaiting_approval' }));
    const [endpoint, opts] = api.mock.calls[0];
    expect(endpoint).toBe(`/api/specs/approvals?workspaceId=${WS}`);
    expect(opts?.method ?? 'GET').toBe('GET');
    expect(r).toContain('3 spec revisions wait for your approval');
    expect(r).toContain(INBOX);
    expect(r).not.toMatch(/request=|token/i);
  });

  it('from an API key, the workspace\'s count; none waiting says so', async () => {
    api.mockResolvedValueOnce({ count: 1, scope: 'workspace', inboxUrl: INBOX });
    expect(out(await call(api, { action: 'awaiting_approval' }))).toContain('1 spec revision waits for approval in this workspace');
    api.mockResolvedValueOnce({ count: 0, scope: 'person', inboxUrl: INBOX });
    expect(out(await call(api, { action: 'awaiting_approval' }))).toContain('Nothing waits for your approval');
  });
});

describe('approve names the inbox (R-8)', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('from an OAuth session: still a link, nothing approved, and the inbox', async () => {
    api.mockResolvedValueOnce({ spec: { title: 'Checkout', version: 2 }, pending: { confirmUrl: `https://buildd.dev/app/specs/${SPEC}/approve?request=tok`, revision: 2, expiresAt: '2026-10-24T00:00:00.000Z', sentTo: 'Sam', gate: { passed: true, refusals: [], warnings: [] }, inboxUrl: INBOX } });
    const r = out(await call(api, { action: 'approve', specId: SPEC, revision: 2, expectedVersion: 2 }));
    expect(r).toContain('Not approved yet');
    expect(r).toContain(INBOX);
  });

  it('AC-6: an API key\'s 403 passes the route\'s text through, naming the inbox and the spec page', async () => {
    api.mockRejectedValueOnce(new Error(`API error: 403 - ${JSON.stringify({ error: `Approving a spec is a person's decision. A person approves it on buildd.dev: https://buildd.dev/app/specs/${SPEC}, or with everything waiting for approval at ${INBOX}.` })}`));
    const r: any = await call(api, { action: 'approve', specId: SPEC, revision: 2, expectedVersion: 2 });
    expect(r.isError).toBe(true);
    expect(out(r)).toContain(INBOX);
    expect(out(r)).toContain(`/app/specs/${SPEC}`);
  });
});

describe('retire and restore from an OAuth session (R-11)', () => {
  let api: ReturnType<typeof mock>;
  beforeEach(() => { api = mock(); });

  it('AC-8: a retire returns the confirm link and says nothing changed yet', async () => {
    api.mockResolvedValueOnce({ spec: { id: SPEC, title: 'Checkout', status: 'draft', version: 3 }, pending: { op: 'retire', confirmUrl: `https://buildd.dev/app/specs/${SPEC}/retire?request=tok`, expiresAt: '2026-10-24T00:00:00.000Z', to: 'retired' } });
    const r = out(await call(api, { action: 'retire', specId: SPEC, reason: 'A duplicate of the checkout spec' }));
    expect(r).toContain('Not retired yet');
    expect(r).toContain(`/app/specs/${SPEC}/retire?request=tok`);
    expect(r).toContain('still draft');
  });

  it('a restore likewise', async () => {
    api.mockResolvedValueOnce({ spec: { id: SPEC, title: 'Checkout', status: 'retired', version: 4 }, pending: { op: 'restore', confirmUrl: `https://buildd.dev/app/specs/${SPEC}/retire?request=tok`, expiresAt: '2026-10-24T00:00:00.000Z', to: 'approved' } });
    const r = out(await call(api, { action: 'restore', specId: SPEC }));
    expect(r).toContain('Not restored yet');
    expect(r).toContain('approved');
  });
});
