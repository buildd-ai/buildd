import { describe, expect, it } from 'bun:test';
import {
  createPolicyPageLedger,
  digestPolicyDecisions,
  policyDigestLine,
  type PolicyDecisionCandidate,
} from '../policy-digest';

const c = (key: string, over: Partial<PolicyDecisionCandidate> = {}): PolicyDecisionCandidate => ({
  key, teamId: 'team-a', owner: 'person', rail: 'protected_path', ...over,
});

describe('digestPolicyDecisions', () => {
  it('folds same-kind decisions into one digest and keeps every member reachable', () => {
    const { digests, rest } = digestPolicyDecisions([c('pr:w:1'), c('pr:w:2'), c('pr:w:3')]);
    expect(rest).toHaveLength(0);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ kind: 'protected_path', teamId: 'team-a', count: 3 });
    expect(digests[0].members.map(m => m.key)).toEqual(['pr:w:1', 'pr:w:2', 'pr:w:3']);
  });

  it('keeps distinct kinds as distinct lines', () => {
    const { digests } = digestPolicyDecisions([
      c('a'), c('b'), c('d', { rail: 'data_migration' }), c('e', { rail: 'data_migration' }),
    ]);
    expect(digests.map(d => [d.kind, d.count]).sort()).toEqual([['data_migration', 2], ['protected_path', 2]]);
  });

  it('leaves a lone decision as an individual card', () => {
    const { digests, rest } = digestPolicyDecisions([c('a'), c('b', { rail: 'security' })]);
    expect(digests).toHaveLength(0);
    expect(rest.map(r => r.key)).toEqual(['a', 'b']);
  });

  it('never counts machine-owned, resolved or stale subjects', () => {
    const { digests, rest } = digestPolicyDecisions([
      c('a'), c('b'),
      c('machine', { owner: 'buildd' }),
      c('acting', { machineActing: true }),
      c('merged', { prLifecycleStatus: 'merged' }),
      c('closed', { prLifecycleStatus: 'closed' }),
      c('stale', { headIsCurrent: false }),
    ]);
    expect(digests[0].count).toBe(2);
    expect(digests[0].members.map(m => m.key)).toEqual(['a', 'b']);
    expect(rest.map(r => r.key)).toEqual(['machine', 'acting', 'merged', 'closed', 'stale']);
  });

  it('does not fold a judgment ask (no policy rail) or a no-next-step fallback', () => {
    const { digests, rest } = digestPolicyDecisions([c('a', { rail: undefined }), c('b', { rail: undefined }), c('d', { rail: 'no_next_step' }), c('e', { rail: 'no_next_step' })]);
    expect(digests).toHaveLength(0);
    expect(rest).toHaveLength(4);
  });

  it('never folds across tenants, and never folds a subject with no tenant', () => {
    const { digests, rest } = digestPolicyDecisions([
      c('a'), c('b', { teamId: 'team-b' }), c('d', { teamId: null }), c('e', { teamId: null }),
    ]);
    expect(digests).toHaveLength(0);
    expect(rest).toHaveLength(4);
  });

  it('counts a repeated subject once', () => {
    const { digests, rest } = digestPolicyDecisions([c('a'), c('a'), c('b')]);
    expect(digests[0].count).toBe(2);
    expect(rest).toHaveLength(0);
  });

  it('a person-owned item with a pending individual approval requirement stays individually approvable', () => {
    const { digests } = digestPolicyDecisions([c('a'), c('b')]);
    expect(digests[0].members.every(m => m.owner === 'person')).toBe(true);
  });
});

describe('policyDigestLine', () => {
  it('says the kind and the count in plain words', () => {
    expect(policyDigestLine('protected_path', 3)).toBe('3 changes to protected files need your OK');
    expect(policyDigestLine('data_migration', 2)).toBe('2 data migrations need your OK');
    expect(policyDigestLine('security', 2)).toBe('2 security concerns need your decision');
  });
});

describe('createPolicyPageLedger', () => {
  const t0 = 1_000_000;
  const mk = () => {
    let now = t0;
    const ledger = createPolicyPageLedger({ windowMs: 30 * 60_000, now: () => now });
    return { ledger, tick: (ms: number) => { now += ms; } };
  };
  const ev = (over: Record<string, unknown> = {}) => ({ teamId: 'team-a', subjectKey: 'pr:w:1', kind: 'protected_path' as const, fingerprint: 'f1', ...over });

  it('first page is individual', () => {
    expect(mk().ledger.plan(ev())).toEqual({ action: 'send' });
  });

  it('a repeated event for the same state is skipped', () => {
    const { ledger } = mk();
    ledger.plan(ev());
    expect(ledger.plan(ev())).toEqual({ action: 'skip' });
  });

  it('a changed state for the same subject is a new page', () => {
    const { ledger } = mk();
    ledger.plan(ev());
    expect(ledger.plan(ev({ fingerprint: 'f2' }))).toEqual({ action: 'send' });
  });

  it('a second subject of the same kind becomes one digest; later ones are quiet', () => {
    const { ledger } = mk();
    ledger.plan(ev());
    expect(ledger.plan(ev({ subjectKey: 'pr:w:2' }))).toEqual({ action: 'digest', count: 2 });
    expect(ledger.plan(ev({ subjectKey: 'pr:w:3' }))).toEqual({ action: 'skip' });
  });

  it('kinds are independent', () => {
    const { ledger } = mk();
    ledger.plan(ev());
    expect(ledger.plan(ev({ subjectKey: 'pr:w:2', kind: 'data_migration' }))).toEqual({ action: 'send' });
  });

  it('tenants are isolated', () => {
    const { ledger } = mk();
    ledger.plan(ev());
    expect(ledger.plan(ev({ teamId: 'team-b' }))).toEqual({ action: 'send' });
    expect(ledger.plan(ev({ teamId: 'team-b', subjectKey: 'pr:w:9' }))).toEqual({ action: 'digest', count: 2 });
  });

  it('pages again once the window passes', () => {
    const { ledger, tick } = mk();
    ledger.plan(ev());
    tick(31 * 60_000);
    expect(ledger.plan(ev())).toEqual({ action: 'send' });
  });
});
