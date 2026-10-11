import { describe, expect, it } from 'bun:test';
import {
  accessStatusLine,
  approveLabel,
  decisionResultText,
  effectsFor,
  formatLease,
  leaseChoices,
  providerState,
  type AccessRequestView,
} from './capability-grants-view';

const NOW = new Date('2026-10-11T12:00:00Z');
const row = (over: Partial<AccessRequestView>): AccessRequestView => ({
  id: 'r', status: 'pending', capability: 'observability:query', provider: 'axiom', risk: 'query', tool: null, resource: null,
  environment: null, workspaceId: 'w', taskId: 't', roleSlug: null, decidedBy: null, ttlSeconds: 3600, expiresAt: null, revokedAt: null, ...over,
});

describe('formatLease / leaseChoices', () => {
  it('reads as a person would say it', () => {
    expect(formatLease(60)).toBe('1 minute');
    expect(formatLease(15 * 60)).toBe('15 minutes');
    expect(formatLease(3600)).toBe('1 hour');
    expect(formatLease(86_400)).toBe('1 day');
    expect(approveLabel(4 * 3600)).toBe('Approve for 4 hours');
  });
  it('offers the asked lease and only shorter ones: approval can only narrow', () => {
    expect(leaseChoices(4 * 3600)).toEqual([900, 3600, 4 * 3600]);
    expect(leaseChoices(4 * 3600 + 1).at(-1)).toBe(4 * 3600 + 1);
    expect(leaseChoices(600)).toEqual([600]);
  });
});

describe('effectsFor', () => {
  it('never offers automatic allow for write or admin', () => {
    expect(effectsFor('read')).toContain('auto_grant');
    expect(effectsFor('write')).not.toContain('auto_grant');
    expect(effectsFor('admin')).not.toContain('auto_grant');
  });
});

describe('accessStatusLine', () => {
  it('names who decided and what to do next', () => {
    expect(accessStatusLine(row({ status: 'granted', decidedBy: 'policy', expiresAt: '2026-10-11T12:30:00Z' }), NOW)).toBe('Allowed by team policy · 30 minutes left');
    expect(accessStatusLine(row({ status: 'granted', decidedBy: 'human', decidedByName: 'Sam' }), NOW)).toBe('Approved by Sam');
    expect(accessStatusLine(row({ status: 'denied', decidedByName: 'Sam', decisionReason: 'use staging' }), NOW)).toContain('Denied by Sam: use staging');
    expect(accessStatusLine(row({ status: 'expired', decidedBy: 'system', decisionReason: 'task_terminal' }), NOW)).toContain('the task ended');
    expect(accessStatusLine(row({ status: 'expired', decidedBy: 'human' }), NOW)).toContain('can ask again');
  });
});

describe('decisionResultText', () => {
  it('a repeat is success; someone else\'s decision is reported as it stands', () => {
    expect(decisionResultText('approve', 200, { alreadyDecided: true })).toEqual({ ok: true, text: 'Already approved.' });
    expect(decisionResultText('deny', 409, { grant: { status: 'granted' } })).toEqual({ ok: false, text: 'Someone already decided: this request is granted.' });
    expect(decisionResultText('approve', 409, { error: 'The task has ended; the request was closed.' }).text).toContain('task has ended');
    expect(decisionResultText('approve', 403, {}).ok).toBe(false);
  });
});

describe('providerState', () => {
  const axiom = { url: 'https://mcp.axiom.co/mcp', authMode: 'oauth' as const };
  const vercel = { url: 'https://mcp.vercel.com', authMode: 'oauth' as const, clientSupport: { status: 'needs_approved_client' as const, detail: '', actionLabel: '', actionUrl: '' } };
  it('matches the installed connector by host and reads its credential', () => {
    expect(providerState(axiom, []).action?.kind).toBe('install');
    expect(providerState(axiom, [{ id: 'c', url: 'https://mcp.axiom.co/sse', authMode: 'oauth', status: 'connected' }]).kind).toBe('connected');
    expect(providerState(axiom, [{ id: 'c', url: 'https://mcp.axiom.co/mcp', authMode: 'oauth', status: 'expired' }]).action).toEqual({ kind: 'connect', label: 'Reconnect', connectorId: 'c' });
    expect(providerState(axiom, [{ id: 'c', url: 'https://mcp.axiom.co/mcp', authMode: 'oauth', status: 'not_connected' }]).action?.label).toBe('Connect');
  });
  it('a provider that has not approved buildd offers no install or connect', () => {
    expect(providerState(vercel, [])).toMatchObject({ kind: 'needs_client_approval', action: null });
    expect(providerState(vercel, [{ id: 'c', url: 'https://mcp.vercel.com', authMode: 'oauth', status: 'not_connected' }]).action).toBeNull();
  });
  it('a shared-in connector offers no credential step: its owner team holds it', () => {
    expect(providerState(axiom, [{ id: 'c', url: 'https://mcp.axiom.co/mcp', authMode: 'oauth', status: 'expired', shared: true }]).action).toBeNull();
  });
});
