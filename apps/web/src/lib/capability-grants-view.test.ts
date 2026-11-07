import { describe, expect, it } from 'bun:test';
import {
  accessIntent,
  accessStatusLine,
  defaultEffectText,
  approveLabel,
  decisionResultText,
  effectsFor,
  formatLease,
  leaseChoices,
  policySummary,
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

describe('policySummary', () => {
  it('names only what differs from the default', () => {
    expect(policySummary([])).toBe('Defaults');
    expect(policySummary([{ risk: 'write', effect: 'forbidden' }, { risk: 'read', effect: 'auto_grant' }])).toBe('Read: allow automatically · Write: never allow');
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
    expect(accessStatusLine(row({ status: 'expired', decidedBy: 'system', decisionReason: 'wait_window_elapsed' }), NOW)).toBe('Closed: nobody answered within the wait window. The agent finishes without it and says so.');
    expect(accessStatusLine(row({ status: 'expired', decidedBy: 'agent', decisionReason: 'withdrawn' }), NOW)).toBe('Closed: the agent withdrew it. Nothing to decide.');
    expect(accessStatusLine(row({ status: 'expired', decidedBy: 'agent', decisionReason: 'agent_stopped_waiting' }), NOW)).toContain('finished without waiting');
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


describe('defaultEffectText for a brokered Neon read', () => {
  it('a Neon read asks a person with no rule; other providers keep the mount default', () => {
    expect(defaultEffectText('read', 'neon')).toBe('Ask a person');
    expect(defaultEffectText('read', 'axiom')).toBe('Allow if the agent uses it');
    expect(defaultEffectText('write', 'neon')).toBe('Ask a person');
  });
});

describe('accessIntent', () => {
  it('shows the SQL a database read declared, else its tables, and nothing for other asks', () => {
    expect(accessIntent(row({ capability: 'database.query', scope: { sql: ' select id from tasks ' } }))).toBe('select id from tasks');
    expect(accessIntent(row({ capability: 'database.query', scope: { tables: ['tasks', 'workers'] } }))).toBe('Tables: tasks, workers');
    expect(accessIntent(row({ capability: 'database.query', scope: { sql: 'x'.repeat(700) } }))).toHaveLength(602);
    expect(accessIntent(row({ capability: 'database.query', scope: null }))).toBeNull();
    expect(accessIntent(row({ capability: 'model.inference', scope: { sql: 'select 1' } }))).toBeNull();
  });
});
