import { describe, expect, it } from 'bun:test';
import { mayPageEscalation, verdictsAllowPage } from './escalation-notify';

const buildd = { owner: 'buildd' as const, by: 'rule' as const, action: 'ci_fix' as const, reason: 'fixing' };
const person = { owner: 'person' as const, by: 'rule' as const, rail: 'protected_path' as const, reason: 'protected' };

describe('escalation pushes follow the gate', () => {
  it('a PR Buildd owns does not page', () => {
    expect(verdictsAllowPage([buildd])).toBe(false);
  });

  it('a person-owned PR pages', () => {
    expect(verdictsAllowPage([person])).toBe(true);
    expect(verdictsAllowPage([buildd, person])).toBe(true);
  });

  it('no verdict pages exactly as before', () => {
    expect(verdictsAllowPage([])).toBe(true);
  });

  it('a failed read pages', async () => {
    expect(await mayPageEscalation({ workspaceId: 'ws', prNumber: 1 }, { loadVerdicts: async () => { throw new Error('down'); } })).toBe(true);
  });

  it('reads the verdicts for this PR', async () => {
    const seen: unknown[] = [];
    expect(await mayPageEscalation({ workspaceId: 'ws', prNumber: 4 }, { loadVerdicts: async (ws, n) => { seen.push([ws, n]); return [buildd]; } })).toBe(false);
    expect(seen).toEqual([['ws', 4]]);
  });
});

describe('policy pages batch into a digest and dedupe', () => {
  const { planEscalationPage } = require('./escalation-notify') as typeof import('./escalation-notify');
  const { createPolicyPageLedger } = require('@buildd/core/policy-digest') as typeof import('@buildd/core/policy-digest');
  const mk = () => createPolicyPageLedger();
  const ev = (prNumber: number, teamId = 'team-a', verdict: typeof person = person) => ({ teamId, workspaceId: 'ws', prNumber, verdicts: [verdict] });

  it('a non-policy page is untouched', () => {
    expect(planEscalationPage(ev(1, 'team-a', { ...person, rail: undefined } as never), mk())).toEqual({ action: 'send' });
  });

  it('the first policy page is individual, the second of its kind is one digest, the rest quiet', () => {
    const ledger = mk();
    expect(planEscalationPage(ev(1), ledger)).toEqual({ action: 'send' });
    expect(planEscalationPage(ev(2), ledger)).toEqual({ action: 'digest', count: 2, kind: 'protected_path' });
    expect(planEscalationPage(ev(3), ledger)).toEqual({ action: 'skip' });
  });

  it('a repeated event for the same PR and state sends once', () => {
    const ledger = mk();
    planEscalationPage(ev(1), ledger);
    expect(planEscalationPage(ev(1), ledger)).toEqual({ action: 'skip' });
  });

  it('another tenant is paged independently', () => {
    const ledger = mk();
    planEscalationPage(ev(1), ledger);
    expect(planEscalationPage(ev(1, 'team-b'), ledger)).toEqual({ action: 'send' });
  });
});
