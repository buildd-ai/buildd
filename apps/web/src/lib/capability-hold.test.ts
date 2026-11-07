/**
 * A pending access request holds the run (capability-hold.ts): the completion
 * verdict against a worker's request rows, the wait window, and what the
 * declarations do to the summary.
 */
import { describe, expect, it } from 'bun:test';
import {
  CLOSE_REASONS,
  DEFAULT_ACCESS_WAIT_WINDOW_SECONDS,
  accessDecisionNotice,
  completionHoldVerdict,
  leadSummary,
  parseBlockedByCapability,
  parseProceededWithout,
  requestStanding,
  waitWindowMs,
  wasEverGranted,
  type HeldRequestRow,
} from './capability-hold';

const NOW = new Date('2026-11-07T12:00:00Z');
const WINDOW = waitWindowMs(null);
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const row = (over: Partial<HeldRequestRow> = {}): HeldRequestRow => ({
  id: R1, capability: 'database.query', provider: 'neon', risk: 'read', tool: null, resource: null,
  status: 'pending', decidedBy: null, decidedAt: null, decisionReason: null,
  requestedAt: new Date(NOW.getTime() - 10 * 60_000), expiresAt: null, ...over,
});
const verdict = (rows: HeldRequestRow[], structuredOutput: unknown = undefined, over: { unusable?: (r: HeldRequestRow) => string | null; now?: Date } = {}) =>
  completionHoldVerdict({ rows, structuredOutput, now: over.now ?? NOW, windowMs: WINDOW, unusable: over.unusable ?? (() => null), ask: r => `Read ${r.provider}` });

describe('waitWindowMs', () => {
  it('defaults to 4 hours and clamps a team setting', () => {
    expect(waitWindowMs(null)).toBe(DEFAULT_ACCESS_WAIT_WINDOW_SECONDS * 1000);
    expect(waitWindowMs(undefined)).toBe(4 * 3600 * 1000);
    expect(waitWindowMs(1800)).toBe(1800 * 1000);
    expect(waitWindowMs(1)).toBe(5 * 60 * 1000);
    expect(waitWindowMs(10 ** 9)).toBe(7 * 24 * 3600 * 1000);
    expect(waitWindowMs(Number.NaN)).toBe(4 * 3600 * 1000);
  });
});

describe('wasEverGranted / requestStanding', () => {
  const ctx = { now: NOW, windowMs: WINDOW, unusable: () => null };
  it('a lease that lapsed after a grant was held; a close without a grant was not', () => {
    expect(wasEverGranted(row({ status: 'granted', decidedBy: 'human', decidedAt: NOW }))).toBe(true);
    expect(wasEverGranted(row({ status: 'expired', decidedBy: 'policy', decidedAt: NOW, decisionReason: 'default_auto_grant' }))).toBe(true);
    expect(wasEverGranted(row({ status: 'revoked', decidedBy: 'human', decidedAt: NOW, decisionReason: 'revoked' }))).toBe(true);
    expect(wasEverGranted(row({ status: 'denied', decidedBy: 'human', decidedAt: NOW }))).toBe(false);
    expect(wasEverGranted(row({ status: 'expired', decidedBy: 'system', decidedAt: NOW, decisionReason: CLOSE_REASONS.waitWindowElapsed }))).toBe(false);
    expect(wasEverGranted(row({ status: 'expired', decidedBy: 'agent', decidedAt: NOW, decisionReason: CLOSE_REASONS.withdrawn }))).toBe(false);
    expect(wasEverGranted(row({ status: 'expired', decidedBy: 'system', decidedAt: NOW, decisionReason: 'task_terminal' }))).toBe(false);
    // Revoked while still pending: a person took it back before any grant.
    expect(wasEverGranted(row({ status: 'revoked', decidedBy: null, decidedAt: null, decisionReason: 'revoked' }))).toBe(false);
  });

  it('pending inside the window holds; past it is overdue; a granted but unusable grant counts as ungranted', () => {
    expect(requestStanding(row(), ctx)).toBe('pending');
    expect(requestStanding(row({ requestedAt: new Date(NOW.getTime() - WINDOW) }), ctx)).toBe('overdue');
    expect(requestStanding(row({ status: 'granted', decidedBy: 'human', decidedAt: NOW }), ctx)).toBe('held');
    expect(requestStanding(row({ status: 'granted', decidedBy: 'human', decidedAt: NOW }), { ...ctx, unusable: () => 'query_role_unconfigured' })).toBe('ungranted');
    expect(requestStanding(row({ status: 'denied', decidedBy: 'human', decidedAt: NOW }), ctx)).toBe('ungranted');
  });
});

describe('the declarations', () => {
  it('blockedByCapability needs a request id; whatIsMissing is optional; a list is accepted', () => {
    expect(parseBlockedByCapability({})).toBeNull();
    expect(parseBlockedByCapability({ blockedByCapability: { requestId: R1 } })).toEqual({ ok: true, value: [{ requestId: R1 }] });
    expect(parseBlockedByCapability({ blockedByCapability: [{ requestId: R1, whatIsMissing: ' the counts ' }, { requestId: R2 }] }))
      .toEqual({ ok: true, value: [{ requestId: R1, whatIsMissing: 'the counts' }, { requestId: R2 }] });
    expect(parseBlockedByCapability({ blockedByCapability: { requestId: 'g1' } })).toMatchObject({ ok: false });
    expect(parseBlockedByCapability({ blockedByCapability: 'neon' })).toMatchObject({ ok: false });
    expect(parseBlockedByCapability({ blockedByCapability: [] })).toMatchObject({ ok: false });
  });

  it('proceededWithout needs whatIsMissing', () => {
    expect(parseProceededWithout({ proceededWithout: { requestId: R1 } })).toMatchObject({ ok: false, error: expect.stringContaining('whatIsMissing') });
    expect(parseProceededWithout({ proceededWithout: { requestId: R1, whatIsMissing: 'no PR counts' } })).toEqual({ ok: true, value: [{ requestId: R1, whatIsMissing: 'no PR counts' }] });
  });
});

describe('completionHoldVerdict', () => {
  it('a task with no request behaves as today', () => {
    expect(verdict([])).toEqual({ kind: 'pass', expire: [], stopWaiting: [], blockedByCapability: null, proceededWithout: null, summaryLead: null });
    expect(verdict([], { shipped: { lede: 'x' } }).kind).toBe('pass');
  });

  it('pending request + complete_task: refused with the three ways out', () => {
    const v = verdict([row()]);
    expect(v.kind).toBe('refuse');
    if (v.kind !== 'refuse') throw new Error('expected a refusal');
    expect(v.code).toBe('capability_request_pending');
    expect(v.requestIds).toEqual([R1]);
    expect(v.options).toHaveLength(3);
    expect(v.error).toContain('wait');
    expect(v.error).toContain('withdraw_capability_request');
    expect(v.error).toContain('blockedByCapability');
    expect(v.error).toContain(R1);
    expect(v.error).toContain('Read neon');
  });

  it('a granted, usable request needs nothing: the run completes as today', () => {
    const v = verdict([row({ status: 'granted', decidedBy: 'human', decidedAt: NOW, expiresAt: new Date(NOW.getTime() + 3600_000) })]);
    expect(v).toMatchObject({ kind: 'pass', expire: [], stopWaiting: [], summaryLead: null });
    // A lease that ran out after being used is not something the run went without.
    expect(verdict([row({ status: 'expired', decidedBy: 'policy', decidedAt: NOW, decisionReason: 'default_auto_grant' })]).kind).toBe('pass');
  });

  it('naming a live grant as a blocker is refused: use it', () => {
    const v = verdict([row({ status: 'granted', decidedBy: 'human', decidedAt: NOW })], { blockedByCapability: { requestId: R1 } });
    expect(v).toMatchObject({ kind: 'refuse', code: 'capability_held', hint: 'use_capability' });
  });

  it('a request id this worker never made is refused', () => {
    expect(verdict([row()], { blockedByCapability: { requestId: R2 } })).toMatchObject({ kind: 'refuse', code: 'capability_request_unknown' });
    expect(verdict([], { proceededWithout: { requestId: R2, whatIsMissing: 'x' } })).toMatchObject({ kind: 'refuse', code: 'capability_request_unknown' });
  });

  it('a malformed declaration is refused before anything is read', () => {
    expect(verdict([row()], { blockedByCapability: { requestId: 'nope' } })).toMatchObject({ kind: 'refuse', code: 'invalid_capability_outcome' });
    expect(verdict([row()], { proceededWithout: { requestId: R1 } })).toMatchObject({ kind: 'refuse', code: 'invalid_capability_outcome' });
  });

  it('completing with blockedByCapability on a pending request closes it and leads the summary', () => {
    const v = verdict([row()], { blockedByCapability: { requestId: R1, whatIsMissing: 'The PR-landing half of the measurement is missing.' } });
    expect(v.kind).toBe('pass');
    if (v.kind !== 'pass') throw new Error('expected a pass');
    expect(v.stopWaiting).toEqual([R1]);
    expect(v.expire).toEqual([]);
    expect(v.blockedByCapability).toEqual([{ requestId: R1, whatIsMissing: 'The PR-landing half of the measurement is missing.', outcome: 'abandoned', reason: null }]);
    expect(v.summaryLead).toBe('Blocked: Read neon was not answered before the run finished. The PR-landing half of the measurement is missing.');
  });

  it('a refused request: blockedByCapability carries the person\'s reason; without a declaration the completion is refused', () => {
    const denied = row({ status: 'denied', decidedBy: 'human', decidedAt: NOW, decisionReason: 'not for this task' });
    expect(verdict([denied])).toMatchObject({ kind: 'refuse', code: 'capability_outcome_unreported', requestIds: [R1] });
    const v = verdict([denied], { blockedByCapability: { requestId: R1 } });
    expect(v).toMatchObject({ kind: 'pass', blockedByCapability: [{ requestId: R1, outcome: 'denied', reason: 'not for this task' }] });
    expect((v as { summaryLead: string }).summaryLead).toBe('Blocked: Read neon was refused by a person ("not for this task").');
  });

  it('wait window passed: the request is expired by the server, never closed as "task ended", and the completion must say so', () => {
    const overdue = row({ requestedAt: new Date(NOW.getTime() - WINDOW - 1) });
    expect(verdict([overdue])).toMatchObject({ kind: 'refuse', code: 'capability_outcome_unreported' });
    const v = verdict([overdue], { blockedByCapability: { requestId: R1, whatIsMissing: 'No production counts.' } });
    expect(v).toMatchObject({ kind: 'pass', expire: [R1], stopWaiting: [], blockedByCapability: [{ requestId: R1, outcome: 'expired', reason: CLOSE_REASONS.waitWindowElapsed }] });
    expect((v as { summaryLead: string }).summaryLead).toContain('not answered within the wait window');
  });

  it('completing after withdrawing needs proceededWithout, which then leads the summary', () => {
    const withdrawn = row({ status: 'expired', decidedBy: 'agent', decidedAt: NOW, decisionReason: CLOSE_REASONS.withdrawn });
    expect(verdict([withdrawn])).toMatchObject({ kind: 'refuse', code: 'capability_outcome_unreported' });
    expect(verdict([withdrawn], { proceededWithout: { requestId: R1 } })).toMatchObject({ kind: 'refuse', code: 'invalid_capability_outcome' });
    const v = verdict([withdrawn], { proceededWithout: { requestId: R1, whatIsMissing: 'Merge latency is estimated from GitHub only.' } });
    expect(v).toMatchObject({ kind: 'pass', proceededWithout: [{ requestId: R1, outcome: 'withdrawn', whatIsMissing: 'Merge latency is estimated from GitHub only.' }] });
    expect((v as { summaryLead: string }).summaryLead).toBe('Proceeded without Read neon (withdrawn): Merge latency is estimated from GitHub only.');
  });

  it('a grant that cannot run is its own refusal, not a denial', () => {
    const granted = row({ status: 'granted', decidedBy: 'human', decidedAt: NOW });
    const unusable = (r: HeldRequestRow) => (r.capability === 'database.query' ? 'query_role_unconfigured' : null);
    expect(verdict([granted], undefined, { unusable })).toMatchObject({ kind: 'refuse', code: 'capability_outcome_unreported' });
    const v = verdict([granted], { blockedByCapability: { requestId: R1 } }, { unusable });
    expect(v).toMatchObject({ kind: 'pass', blockedByCapability: [{ requestId: R1, outcome: 'query_role_unconfigured', reason: null }] });
    expect((v as { summaryLead: string }).summaryLead).toContain('no read-only query role is configured');
  });

  it('two requests: one pending holds even when the other is declared', () => {
    const v = verdict([row(), row({ id: R2, provider: 'axiom', capability: 'axiom:read' })], { blockedByCapability: { requestId: R1 } });
    expect(v).toMatchObject({ kind: 'refuse', code: 'capability_request_pending', requestIds: [R2] });
  });
});

describe('leadSummary', () => {
  it('puts the declaration first and keeps the agent\'s summary', () => {
    expect(leadSummary(null, 'done')).toBe('done');
    expect(leadSummary(null, undefined)).toBeUndefined();
    expect(leadSummary('Blocked: x.', 'Shipped the report.')).toBe('Blocked: x.\n\nShipped the report.');
    expect(leadSummary('Blocked: x.', '  ')).toBe('Blocked: x.');
  });
});

describe('accessDecisionNotice', () => {
  const r = { id: R1, capability: 'database.query' };
  it('an approval says to use it; a refusal carries the reason and the two completions; an expiry names the window', () => {
    expect(accessDecisionNotice(r, 'approved', { ask: 'Read Neon', spendWith: 'query_database { sql }' })).toContain('query_database { sql }');
    const denied = accessDecisionNotice(r, 'denied', { ask: 'Read Neon', reason: 'not for this task' });
    expect(denied).toContain('refused by a person');
    expect(denied).toContain('"not for this task"');
    expect(denied).toContain(`blockedByCapability { requestId: "${R1}"`);
    expect(denied).toContain('proceededWithout');
    const expired = accessDecisionNotice(r, 'expired', { ask: 'Read Neon', windowMs: 4 * 3600_000 });
    expect(expired).toContain('(4 h)');
    expect(expired).toContain('blockedByCapability');
    for (const n of [denied, expired]) expect(n.startsWith(`[access `)).toBe(true);
  });
});
